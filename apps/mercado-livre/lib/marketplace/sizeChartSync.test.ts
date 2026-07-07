import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreHttpError, type MercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import type { MlSizeChart } from '@delfrance/schemas';

import {
  TabelaDeMedidasNotFoundError,
  applyChartResponse,
  chartAttributeToMercadoLivre,
  chartCreatePayload,
  chartRowPayload,
  deepEqual,
  syncSizeCharts,
} from './sizeChartSync';

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

const CHART_RESPONSE = {
  id: '1594439',
  main_attribute_id: 'SIZE',
  rows: [{ id: '1594439:1' }, { id: '1594439:2' }],
};

function makeApi(overrides: Partial<Record<string, unknown>> = {}) {
  const mocks = {
    createSizeChart: vi.fn(async () => CHART_RESPONSE),
    updateSizeChartName: vi.fn(async () => CHART_RESPONSE),
    addSizeChartRow: vi.fn(async () => CHART_RESPONSE),
    updateSizeChartRow: vi.fn(async () => CHART_RESPONSE),
    ...overrides,
  } as Record<string, ReturnType<typeof vi.fn>>;
  return { api: mocks as unknown as MercadoLivreApi, mocks };
}

const novaChart: MlSizeChart = {
  id: null,
  nome: 'Camisetas ML',
  domain_id: 'MLB-T_SHIRTS',
  tipo: 'CLOTHING_MEASURE',
  attributes: [{ id: 'GENDER', value_id: '339665', value_name: 'Feminino' }],
  main_attribute: [],
  rows: [
    {
      varianteUid: 'documents/grupoDeVariacoes/g/variacoes/v-m',
      id: null,
      attributes: [
        { id: 'SIZE', value_name: 'M' },
        { id: 'CHEST_CIRCUMFERENCE_FROM', value_name: '90', unit_id: 'cm' },
      ],
    },
    {
      varianteUid: 'documents/grupoDeVariacoes/g/variacoes/v-g',
      id: null,
      attributes: [{ id: 'SIZE', value_name: 'G' }],
    },
  ],
};

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

/* ------------------------------ pure builders ---------------------------- */

describe('chartAttributeToMercadoLivre', () => {
  it('folds the unit into the value name (legacy "62 cm")', () => {
    expect(chartAttributeToMercadoLivre({ id: 'WAIST', value_name: '62', unit_id: 'cm' })).toEqual({
      id: 'WAIST',
      values: [{ name: '62 cm' }],
    });
  });

  it('keeps value_id and omits absent parts', () => {
    expect(chartAttributeToMercadoLivre({ id: 'GENDER', value_id: '339665' })).toEqual({
      id: 'GENDER',
      values: [{ id: '339665' }],
    });
  });

  it('valueList produces one entry per item, unit folded per item', () => {
    expect(
      chartAttributeToMercadoLivre({
        id: 'FILTRABLE_SIZE',
        unit_id: 'cm',
        valueList: [{ value_name: '38' }, { value_id: 'x', value_name: '40' }],
      } as never),
    ).toEqual({
      id: 'FILTRABLE_SIZE',
      values: [{ name: '38 cm' }, { id: 'x', name: '40 cm' }],
    });
  });
});

describe('chartCreatePayload', () => {
  it('builds the legacy POST /catalog/charts body (domain suffix, SIZE main-attr fallback)', () => {
    const payload = chartCreatePayload(novaChart);
    expect(payload).toMatchObject({
      names: { MLB: 'Camisetas ML' },
      domain_id: 'T_SHIRTS',
      site_id: 'MLB',
      measure_type: 'CLOTHING_MEASURE',
      attributes: [{ id: 'GENDER', values: [{ id: '339665', name: 'Feminino' }] }],
    });
    // No valued main_attribute → synthetic SIZE from the rows.
    expect(payload.main_attribute).toEqual({
      attributes: [
        {
          site_id: 'MLB',
          id: 'SIZE',
          values: [
            { id: null, name: 'M' },
            { id: null, name: 'G' },
          ],
        },
      ],
    });
    const rows = payload.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.attributes).toEqual([
      { id: 'SIZE', values: [{ name: 'M' }] },
      { id: 'CHEST_CIRCUMFERENCE_FROM', values: [{ name: '90 cm' }] },
    ]);
  });

  it('omits measure_type when tipo is absent', () => {
    expect(chartCreatePayload({ ...novaChart, tipo: null })).not.toHaveProperty('measure_type');
  });
});

describe('chartRowPayload', () => {
  const chart: MlSizeChart = { ...novaChart, id: '1594439', main_attribute_id: 'SIZE' };
  const row = {
    varianteUid: null,
    id: '1594439:1',
    attributes: [
      { id: 'SIZE', value_name: 'M' },
      { id: 'WAIST', value_name: '62', unit_id: 'cm' },
    ],
  };

  it('row UPDATE excludes the main attribute (immutable on ML)', () => {
    expect(chartRowPayload(chart, row)).toEqual({
      sites: ['MLB'],
      attributes: [{ id: 'WAIST', values: [{ name: '62 cm' }] }],
    });
  });

  it('NEW row (no ML id) includes the main attribute', () => {
    const attrs = chartRowPayload(chart, { ...row, id: null }).attributes as unknown[];
    expect(attrs).toHaveLength(2);
  });
});

describe('applyChartResponse', () => {
  it('writes back chart id, main_attribute_id and per-INDEX row ids', () => {
    const updated = applyChartResponse(novaChart, CHART_RESPONSE);
    expect(updated.id).toBe('1594439');
    expect(updated.main_attribute_id).toBe('SIZE');
    expect(updated.rows![0]!.id).toBe('1594439:1');
    expect(updated.rows![1]!.id).toBe('1594439:2');
  });

  it('extra local rows (beyond the response) keep their state', () => {
    const updated = applyChartResponse(novaChart, { ...CHART_RESPONSE, rows: [{ id: 'X:1' }] });
    expect(updated.rows![0]!.id).toBe('X:1');
    expect(updated.rows![1]!.id).toBeNull();
  });
});

describe('deepEqual', () => {
  it('structural equality on JSON data', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});

/* ------------------------------ orchestrator ----------------------------- */

describe('syncSizeCharts', () => {
  it('creates a new chart and merges ONLY this conta (others + Shopee survive)', async () => {
    const db = new FakeDb();
    seedDoc(db, []);
    const { api, mocks } = makeApi();

    const result = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [novaChart],
    );

    expect(mocks.createSizeChart).toHaveBeenCalledOnce();
    expect(result.updated).toBe(true);
    expect(result.validationErrors).toEqual([]);
    expect(result.tabelas[0]!.id).toBe('1594439');
    expect(result.tabelas[0]!.rows![0]!.id).toBe('1594439:1');

    const doc = db.docs('tabMedi').get(TAB)!;
    const map = doc.tabelasDeMedidasMercadoLivre as Record<string, { tabelas: MlSizeChart[] }>;
    expect(map[CONTA]!.tabelas[0]!.id).toBe('1594439');
    // Deep merge preserved the other conta and the Shopee map.
    expect(map['outra-conta']!.tabelas[0]!.id).toBe('999');
    expect(doc.tabelasMedidasShopee).toEqual({ 'conta-shopee': [{ size_chart_id: 1 }] });
  });

  it('name change → PUT name; unchanged charts make no ML calls and no write', async () => {
    const stored = { ...novaChart, id: '1594439', main_attribute_id: 'SIZE' };
    const db = new FakeDb();
    seedDoc(db, [stored]);
    const { api, mocks } = makeApi();

    // Unchanged → nothing happens.
    const same = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [stored],
    );
    expect(same.updated).toBe(false);
    expect(mocks.updateSizeChartName).not.toHaveBeenCalled();

    // Renamed → PUT name only.
    const renamed = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [{ ...stored, nome: 'Novo nome' }],
    );
    expect(mocks.updateSizeChartName).toHaveBeenCalledWith('1594439', { MLB: 'Novo nome' });
    expect(renamed.updated).toBe(true);
  });

  it('row diffs: changed row with id → PUT row; new row → POST row; unchanged skipped', async () => {
    const stored: MlSizeChart = {
      ...novaChart,
      id: '1594439',
      main_attribute_id: 'SIZE',
      rows: [
        {
          varianteUid: 'documents/g/variacoes/v-m',
          id: '1594439:1',
          attributes: [{ id: 'SIZE', value_name: 'M' }],
        },
        {
          varianteUid: 'documents/g/variacoes/v-g',
          id: '1594439:2',
          attributes: [{ id: 'SIZE', value_name: 'G' }],
        },
      ],
    };
    const db = new FakeDb();
    seedDoc(db, [stored]);
    const { api, mocks } = makeApi();

    const edited: MlSizeChart = {
      ...stored,
      rows: [
        // row 0 changed (new measurement attr) — PUT
        {
          ...stored.rows![0]!,
          attributes: [
            ...stored.rows![0]!.attributes!,
            { id: 'WAIST', value_name: '62', unit_id: 'cm' },
          ],
        },
        // row 1 unchanged — skipped
        stored.rows![1]!,
        // row 2 brand new — POST
        {
          varianteUid: 'documents/g/variacoes/v-gg',
          id: null,
          attributes: [{ id: 'SIZE', value_name: 'GG' }],
        },
      ],
    };

    await syncSizeCharts({ db: db as unknown as Firestore, api, integracaoId: CONTA }, TAB, [
      edited,
    ]);

    expect(mocks.updateSizeChartRow!).toHaveBeenCalledTimes(1);
    expect(mocks.updateSizeChartRow!.mock.calls[0]![0]).toBe('1594439');
    expect(mocks.updateSizeChartRow!.mock.calls[0]![1]).toBe('1594439:1');
    // The update payload excludes the SIZE main attribute.
    expect(mocks.updateSizeChartRow!.mock.calls[0]![2]).toEqual({
      sites: ['MLB'],
      attributes: [{ id: 'WAIST', values: [{ name: '62 cm' }] }],
    });
    expect(mocks.addSizeChartRow).toHaveBeenCalledTimes(1);
  });

  it('an ML chart-validation error is collected, keeps the chart, and does not abort', async () => {
    const db = new FakeDb();
    seedDoc(db, []);
    const { api, mocks } = makeApi({
      createSizeChart: vi
        .fn()
        .mockRejectedValueOnce(
          new MercadoLivreHttpError('chart validation', 400, {
            error: 'chart_validation_error',
            errors: [{ code: 'chart_name_unavailable', message: 'name in use' }],
          }),
        )
        .mockResolvedValueOnce({ ...CHART_RESPONSE, id: '777' }),
    });

    const result = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [novaChart, { ...novaChart, nome: 'Segunda' }],
    );

    expect(mocks.createSizeChart).toHaveBeenCalledTimes(2); // continued past the failure
    expect(result.validationErrors).toEqual([
      { chartIndex: 0, code: 'chart_name_unavailable', message: 'name in use' },
    ]);
    expect(result.tabelas[0]!.id).toBeNull(); // failed chart kept as-was
    expect(result.tabelas[1]!.id).toBe('777');
    expect(result.updated).toBe(true); // the second chart landed → write happened
  });

  it('a rejected rename reverts the nome and skips that chart´s rows', async () => {
    const stored: MlSizeChart = { ...novaChart, id: '1594439', main_attribute_id: 'SIZE' };
    const db = new FakeDb();
    seedDoc(db, [stored]);
    const { api, mocks } = makeApi({
      updateSizeChartName: vi.fn(async () => {
        throw new MercadoLivreHttpError('chart validation', 400, {
          errors: [{ code: 'chart_name_unavailable', message: 'in use' }],
        });
      }),
    });

    const edited: MlSizeChart = {
      ...stored,
      nome: 'Nome novo',
      rows: [{ varianteUid: null, id: null, attributes: [{ id: 'SIZE', value_name: 'XG' }] }],
    };
    const result = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [edited],
    );

    expect(result.tabelas[0]!.nome).toBe('Camisetas ML'); // reverted
    expect(mocks.addSizeChartRow).not.toHaveBeenCalled(); // rows skipped
    expect(result.validationErrors).toHaveLength(1);
    expect(result.updated).toBe(false);
  });

  it('non-validation ML errors (5xx) rethrow', async () => {
    const db = new FakeDb();
    seedDoc(db, []);
    const { api } = makeApi({
      createSizeChart: vi.fn(async () => {
        throw new MercadoLivreHttpError('boom', 500, { errors: [{ code: 'x' }] });
      }),
    });

    await expect(
      syncSizeCharts({ db: db as unknown as Firestore, api, integracaoId: CONTA }, TAB, [
        novaChart,
      ]),
    ).rejects.toThrow('boom');
  });

  it('missing tabMedi doc → TabelaDeMedidasNotFoundError', async () => {
    const db = new FakeDb();
    const { api } = makeApi();
    await expect(
      syncSizeCharts({ db: db as unknown as Firestore, api, integracaoId: CONTA }, 'nope', []),
    ).rejects.toThrow(TabelaDeMedidasNotFoundError);
  });
});
