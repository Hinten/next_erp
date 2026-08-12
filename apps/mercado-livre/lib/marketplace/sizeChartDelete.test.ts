import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreHttpError, type MercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import type { MlSizeChart } from '@delfrance/schemas';

import {
  SizeChartNotFoundError,
  requestSizeChartDeletion,
  verifySizeChartDeletion,
} from './sizeChartDelete';
import { TabelaDeMedidasNotFoundError } from './sizeChartSync';

/* ----------------------------- fake Firestore ---------------------------- */

type DocData = Record<string, unknown>;

/** `set(…, {merge: true})` deep-merges maps — the conta-key preservation relies on it. */
function deepMergeInto(target: DocData, patch: DocData): DocData {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    if (
      v &&
      cur &&
      typeof v === 'object' &&
      typeof cur === 'object' &&
      !Array.isArray(v) &&
      !Array.isArray(cur)
    ) {
      out[k] = deepMergeInto(cur as DocData, v as DocData);
    } else {
      out[k] = v;
    }
  }
  return out;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) {
      c = new Map();
      this.cols.set(path, c);
    }
    return c;
  }

  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }

  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }

  collection(path: string) {
    const col = this.col(path);
    return {
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: col.has(id), id, data: () => col.get(id) }),
        set: async (data: DocData, opts?: { merge?: boolean }) => {
          col.set(id, opts?.merge ? deepMergeInto(col.get(id) ?? {}, data) : { ...data });
        },
      }),
    };
  }
}

/* ------------------------------- fixtures -------------------------------- */

const CONTA = 'conta-1';
const TAB = 'tm-1';
const CHART_ID = '1594439';
const NOW = 1_754_900_000_000;

const chart: MlSizeChart = {
  id: CHART_ID,
  nome: 'Camisetas ML',
  domain_id: 'MLB-T_SHIRTS',
  tipo: 'CLOTHING_MEASURE',
  main_attribute_id: 'SIZE',
  attributes: [{ id: 'GENDER', value_id: '339665', value_name: 'Feminino' }],
  main_attribute: [],
  rows: [{ varianteUid: null, id: `${CHART_ID}:1`, attributes: [{ id: 'SIZE', value_name: 'M' }] }],
};

const outraChart: MlSizeChart = { ...chart, id: '888', nome: 'Outra guia' };

function seedDoc(db: FakeDb, tabelas: unknown[]): void {
  db.seed('tabMedi', TAB, {
    nome: 'Tabela camisetas',
    codigo: null,
    descricao: null,
    tabelasDeMedidasMercadoLivre: {
      [CONTA]: { tabelas },
      'outra-conta': { tabelas: [{ id: '999', nome: 'Outra', domain_id: 'MLB-PANTS' }] },
    },
    tabelasMedidasShopee: { 'conta-shopee': [{ size_chart_id: 1 }] },
  });
}

function storedTabelas(db: FakeDb): MlSizeChart[] {
  const doc = db.docs('tabMedi').get(TAB)!;
  const map = doc.tabelasDeMedidasMercadoLivre as Record<string, { tabelas: MlSizeChart[] }>;
  return map[CONTA]!.tabelas;
}

function makeApi(overrides: Partial<Record<string, unknown>> = {}) {
  const mocks = {
    deleteSizeChart: vi.fn(async () => ({ message: 'Before removing the size chart…' })),
    getSizeChart: vi.fn(async () => ({ id: CHART_ID, chart_status: 'ACTIVE' })),
    ...overrides,
  } as Record<string, ReturnType<typeof vi.fn>>;
  return { api: mocks as unknown as MercadoLivreApi, mocks };
}

function deps(db: FakeDb, api: MercadoLivreApi) {
  return { db: db as unknown as Firestore, api, integracaoId: CONTA };
}

/* ------------------------------ request ---------------------------------- */

describe('requestSizeChartDeletion', () => {
  it('calls ML, stamps exclusaoSolicitadaEm and KEEPS the guia on the doc', async () => {
    const db = new FakeDb();
    seedDoc(db, [chart]);
    const { api, mocks } = makeApi();

    const result = await requestSizeChartDeletion(deps(db, api), TAB, CHART_ID, NOW);

    expect(mocks.deleteSizeChart).toHaveBeenCalledWith(CHART_ID);
    expect(result.requested).toBe(true);
    expect(result.message).toBe('Before removing the size chart…');

    // ⚠️ The guia STAYS: ML has only accepted a request, and a chart still
    // linked to a listing is silently kept.
    const tabelas = storedTabelas(db);
    expect(tabelas).toHaveLength(1);
    expect(tabelas[0]!.exclusaoSolicitadaEm).toBe(NOW);
  });

  it('leaves other charts, other contas and the Shopee map untouched', async () => {
    const db = new FakeDb();
    seedDoc(db, [chart, outraChart]);
    const { api } = makeApi();

    await requestSizeChartDeletion(deps(db, api), TAB, CHART_ID, NOW);

    const tabelas = storedTabelas(db);
    expect(tabelas.map((c) => c.id)).toEqual([CHART_ID, '888']);
    expect(tabelas[1]!.exclusaoSolicitadaEm).toBeUndefined();

    const doc = db.docs('tabMedi').get(TAB)!;
    const map = doc.tabelasDeMedidasMercadoLivre as Record<string, { tabelas: MlSizeChart[] }>;
    expect(map['outra-conta']!.tabelas[0]!.id).toBe('999');
    expect(doc.tabelasMedidasShopee).toEqual({ 'conta-shopee': [{ size_chart_id: 1 }] });
  });

  it('does NOT stamp when ML rejects the request', async () => {
    const db = new FakeDb();
    seedDoc(db, [chart]);
    const { api } = makeApi({
      deleteSizeChart: vi.fn(async () => {
        throw new MercadoLivreHttpError('forbidden', 403, { error: 'not_owner' });
      }),
    });

    await expect(requestSizeChartDeletion(deps(db, api), TAB, CHART_ID, NOW)).rejects.toThrow(
      MercadoLivreHttpError,
    );
    // A guia flagged "Exclusão solicitada" that nobody ever asked ML about
    // would be indistinguishable from one ML is still chewing on.
    expect(storedTabelas(db)[0]!.exclusaoSolicitadaEm).toBeUndefined();
  });

  it('rebuilds from a FRESH read, so a concurrent write during the ML call survives', async () => {
    const db = new FakeDb();
    seedDoc(db, [chart]);
    const { api } = makeApi({
      deleteSizeChart: vi.fn(async () => {
        // The still-running Flutter app adds a guia while we are on the wire.
        seedDoc(db, [chart, outraChart]);
        return { message: 'ok' };
      }),
    });

    await requestSizeChartDeletion(deps(db, api), TAB, CHART_ID, NOW);

    expect(storedTabelas(db).map((c) => c.id)).toEqual([CHART_ID, '888']);
  });

  it('404s on an unknown chart id and on a missing tabMedi', async () => {
    const db = new FakeDb();
    seedDoc(db, [chart]);
    const { api, mocks } = makeApi();

    await expect(requestSizeChartDeletion(deps(db, api), TAB, 'nope', NOW)).rejects.toThrow(
      SizeChartNotFoundError,
    );
    expect(mocks.deleteSizeChart).not.toHaveBeenCalled();

    await expect(requestSizeChartDeletion(deps(db, api), 'sem-doc', CHART_ID, NOW)).rejects.toThrow(
      TabelaDeMedidasNotFoundError,
    );
  });
});

/* ------------------------------- verify ---------------------------------- */

describe('verifySizeChartDeletion', () => {
  it('chart_status ACTIVE ⇒ still linked: nothing is removed', async () => {
    const db = new FakeDb();
    seedDoc(db, [{ ...chart, exclusaoSolicitadaEm: NOW }]);
    const { api } = makeApi();

    const result = await verifySizeChartDeletion(deps(db, api), TAB, CHART_ID);

    expect(result).toMatchObject({ removed: false, chartStatus: 'ACTIVE' });
    expect(storedTabelas(db)).toHaveLength(1);
  });

  it('chart_status INACTIVE ⇒ removed: the guia is dropped from the doc', async () => {
    const db = new FakeDb();
    seedDoc(db, [{ ...chart, exclusaoSolicitadaEm: NOW }, outraChart]);
    const { api } = makeApi({
      getSizeChart: vi.fn(async () => ({ id: CHART_ID, chart_status: 'INACTIVE' })),
    });

    const result = await verifySizeChartDeletion(deps(db, api), TAB, CHART_ID);

    expect(result.removed).toBe(true);
    expect(storedTabelas(db).map((c) => c.id)).toEqual(['888']);
  });

  it('a 404 from ML counts as removed — otherwise the entry strands forever', async () => {
    const db = new FakeDb();
    seedDoc(db, [{ ...chart, exclusaoSolicitadaEm: NOW }]);
    const { api } = makeApi({
      getSizeChart: vi.fn(async () => {
        throw new MercadoLivreHttpError('not found', 404, { error: 'not_found' });
      }),
    });

    const result = await verifySizeChartDeletion(deps(db, api), TAB, CHART_ID);

    expect(result).toMatchObject({ removed: true, chartStatus: null });
    expect(storedTabelas(db)).toHaveLength(0);
  });

  it('any other ML failure propagates — a 429 must not read as "removed"', async () => {
    const db = new FakeDb();
    seedDoc(db, [{ ...chart, exclusaoSolicitadaEm: NOW }]);
    const { api } = makeApi({
      getSizeChart: vi.fn(async () => {
        throw new MercadoLivreHttpError('rate limited', 429, { error: 'too_many_requests' });
      }),
    });

    await expect(verifySizeChartDeletion(deps(db, api), TAB, CHART_ID)).rejects.toThrow(
      MercadoLivreHttpError,
    );
    expect(storedTabelas(db)).toHaveLength(1);
  });

  it('a chart with no chart_status at all is treated as still present', async () => {
    const db = new FakeDb();
    seedDoc(db, [{ ...chart, exclusaoSolicitadaEm: NOW }]);
    const { api } = makeApi({ getSizeChart: vi.fn(async () => ({ id: CHART_ID })) });

    const result = await verifySizeChartDeletion(deps(db, api), TAB, CHART_ID);

    expect(result).toMatchObject({ removed: false, chartStatus: null });
    expect(storedTabelas(db)).toHaveLength(1);
  });

  it('404s on an unknown chart id', async () => {
    const db = new FakeDb();
    seedDoc(db, [chart]);
    const { api, mocks } = makeApi();

    await expect(verifySizeChartDeletion(deps(db, api), TAB, 'nope')).rejects.toThrow(
      SizeChartNotFoundError,
    );
    expect(mocks.getSizeChart).not.toHaveBeenCalled();
  });
});
