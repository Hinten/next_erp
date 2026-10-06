import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';
import { OccEngine, type OccTransaction } from '@delfrance/data/testing';
import type { MlSizeChart } from '@delfrance/schemas';
import { SizeChartConflictError } from './chartConflict';

type Doc = Record<string, unknown>;
type Snapshot = { exists: () => boolean; data: () => Doc };
type Ref = { path: string; get: () => Promise<Snapshot> };
type ClientTx = {
  get: (ref: Ref) => Promise<Snapshot>;
  update: (ref: Ref, ...fields: unknown[]) => void;
};

const h = vi.hoisted(() => {
  class ClientFieldPath {
    readonly segments: string[];
    constructor(...segments: string[]) {
      this.segments = segments;
    }
  }
  return {
    FieldPath: ClientFieldPath,
    ref: null as unknown as Ref,
    execute: vi.fn<(callback: (tx: ClientTx) => Promise<unknown>) => Promise<unknown>>(),
  };
});

vi.mock('firebase/firestore', () => ({
  FieldPath: h.FieldPath,
  runTransaction: (_db: unknown, callback: (tx: ClientTx) => Promise<unknown>) =>
    h.execute(callback),
}));
vi.mock('@/lib/data/tabelaDeMedidasCollection', () => ({
  tabelaDeMedidasCollection: { docRef: () => h.ref },
}));

const { saveChartTransaction } = await import('./chartPersistence');

const PATH = 'tabMedi/tab-1';
const CONTA = 'conta.with.dot';
const CHART: MlSizeChart = {
  id: 'ML-1',
  nome: 'Camisetas',
  domain_id: 'MLB-T_SHIRTS',
  rows: [{ id: 'ML-1:1', attributes: [{ id: 'SIZE', value_name: '01' }] }],
};
const OTHER: MlSizeChart = { id: 'ML-2', nome: 'Calças', domain_id: 'MLB-PANTS', rows: [] };

let document: Doc | undefined;
let engine: OccEngine;
let committed: Doc[];
let reads: number;

function baseDocument(tabelas: MlSizeChart[] = [CHART, OTHER]): Doc {
  return {
    nome: 'Tabela',
    descricao: 'Original',
    ultimaModificacao: 100,
    tabelasDeMedidasMercadoLivre: {
      [CONTA]: { tabelas, legacyMetadata: 'keep' },
      outra: { tabelas: [OTHER], legacyMetadata: 'other' },
    },
    tabelasMedidasShopee: { loja: [{ size_chart_id: 42 }] },
  };
}

/** Encoded segment arrays adapt FieldPath without treating a literal dot as a separator. */
function encodePatch(patch: Doc): Doc {
  return Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [JSON.stringify([key]), value]),
  );
}

function applyFields(patch: Doc): void {
  if (document == null) throw new Error('update of missing document');
  const next = structuredClone(document);
  for (const [encoded, value] of Object.entries(patch)) {
    const segments = JSON.parse(encoded) as string[];
    let target = next;
    for (const segment of segments.slice(0, -1)) {
      const previous = target[segment];
      target[segment] =
        previous != null && typeof previous === 'object' && !Array.isArray(previous)
          ? { ...(previous as Doc) }
          : {};
      target = target[segment] as Doc;
    }
    target[segments[segments.length - 1]!] = structuredClone(value);
  }
  document = next;
}

function charts(): MlSizeChart[] {
  const map = document?.tabelasDeMedidasMercadoLivre as Record<string, { tabelas: MlSizeChart[] }>;
  return map[CONTA]!.tabelas;
}

function save(chart: MlSizeChart, chartIndex: number | null = 0, original = CHART) {
  return saveChartTransaction({
    db: {} as Firestore,
    tabMediId: 'tab-1',
    integracaoId: CONTA,
    chart,
    chartIndex,
    original: chartIndex == null ? null : original,
  });
}

function interleave(change: (tx: OccTransaction) => void): void {
  engine.beforeCommit = async () => {
    engine.beforeCommit = null;
    await engine.runTransaction((tx) => {
      change(tx);
      return Promise.resolve();
    });
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  document = structuredClone(baseDocument());
  committed = [];
  reads = 0;
  engine = new OccEngine({
    applyWrite: (kind, _path, patch) => {
      if (kind !== 'update') throw new Error('unexpected write');
      applyFields(patch);
    },
    applyDelete: () => {
      document = undefined;
    },
    recordPatch: (_path, patch) => committed.push(patch),
  });
  h.ref = {
    path: PATH,
    get: () => {
      reads += 1;
      const data = document == null ? undefined : structuredClone(document);
      return Promise.resolve({ exists: () => data != null, data: () => data! });
    },
  };
  h.execute.mockImplementation((callback) =>
    engine.runTransaction((tx) =>
      callback({
        get: (ref) => tx.get(ref),
        update: (ref, ...fields) => {
          const patch: Doc = {};
          for (let i = 0; i < fields.length; i += 2) {
            const field = fields[i];
            const segments = field instanceof h.FieldPath ? field.segments : [String(field)];
            patch[JSON.stringify(segments)] = fields[i + 1];
          }
          tx.update(ref, patch);
        },
      }),
    ),
  );
});

describe('saveChartTransaction', () => {
  it('writes only the account list and the millisecond stamp, including literal dots in its id', async () => {
    const before = structuredClone(document!);
    const edited = { ...CHART, nome: 'Editada' };
    const start = Date.now();
    const result = await save(edited);

    expect(result).toEqual({ tabelas: [edited, OTHER], index: 0, chart: edited });
    expect(charts()).toEqual([edited, OTHER]);
    expect(Object.keys(committed[0]!)).toEqual([
      JSON.stringify(['tabelasDeMedidasMercadoLivre', CONTA, 'tabelas']),
      JSON.stringify(['ultimaModificacao']),
    ]);
    expect(document?.ultimaModificacao).toBeGreaterThanOrEqual(start);
    expect(document?.ultimaModificacao).toBeLessThanOrEqual(Date.now());
    expect(document).toEqual({
      ...before,
      ultimaModificacao: document?.ultimaModificacao,
      tabelasDeMedidasMercadoLivre: {
        ...(before.tabelasDeMedidasMercadoLivre as Doc),
        [CONTA]: { tabelas: [edited, OTHER], legacyMetadata: 'keep' },
      },
    });
  });

  it.each(['same-id edit', 'reordered target', 'removed target', 'deleted parent'])(
    'refuses a %s between read and commit, after an actual OCC retry',
    async (change) => {
      const remote = { ...CHART, nome: 'Outra edição', rows: [] };
      interleave((tx) => {
        if (change === 'deleted parent') {
          tx.delete(h.ref);
          return;
        }
        const tabelas =
          change === 'same-id edit'
            ? [remote, OTHER]
            : change === 'reordered target'
              ? [OTHER, CHART]
              : [OTHER];
        tx.update(h.ref, encodePatch({ tabelasDeMedidasMercadoLivre: { [CONTA]: { tabelas } } }));
      });

      await expect(save({ ...CHART, nome: 'Minha edição' })).rejects.toBeInstanceOf(
        SizeChartConflictError,
      );
      expect(engine.txLog.some((attempt) => attempt.phase === 'abort')).toBe(true);
      expect(reads).toBe(2);
      expect(engine.txLog.filter((attempt) => attempt.phase === 'commit')).toHaveLength(1);
      if (change === 'deleted parent') expect(document).toBeUndefined();
      else expect(charts()[0]?.nome).not.toBe('Minha edição');
    },
  );

  it('rebuilds from a retry and preserves another chart, another account, Shopee and ordinary fields', async () => {
    const remoteOther = { ...OTHER, nome: 'Atualizada remotamente' };
    const remoteMap = {
      [CONTA]: { tabelas: [CHART, remoteOther], legacyMetadata: 'new metadata' },
      outra: { tabelas: [remoteOther], legacyMetadata: 'new account metadata' },
    };
    const shopee = { loja: [{ size_chart_id: 99 }] };
    interleave((tx) =>
      tx.update(
        h.ref,
        encodePatch({
          descricao: 'Outra pessoa',
          tabelasDeMedidasMercadoLivre: remoteMap,
          tabelasMedidasShopee: shopee,
        }),
      ),
    );

    const edited = { ...CHART, nome: 'Editada' };
    expect((await save(edited)).tabelas).toEqual([edited, remoteOther]);
    expect(reads).toBe(2);
    expect(document?.descricao).toBe('Outra pessoa');
    expect(document?.tabelasMedidasShopee).toEqual(shopee);
    expect(document?.tabelasDeMedidasMercadoLivre).toEqual({
      ...remoteMap,
      [CONTA]: { ...remoteMap[CONTA], tabelas: [edited, remoteOther] },
    });
  });

  it('preserves two concurrent appends and returns the index from the committed attempt', async () => {
    document = baseDocument([]);
    const first = { id: null, nome: 'Primeira', domain_id: 'MLB-T_SHIRTS' };
    const second = { id: null, nome: 'Segunda', domain_id: 'MLB-T_SHIRTS' };
    let competingIndex: number | undefined;
    engine.beforeCommit = async () => {
      engine.beforeCommit = null;
      competingIndex = (await save(second, null)).index;
    };

    const result = await save(first, null);

    expect(competingIndex).toBe(0);
    expect(result.index).toBe(1);
    expect(result.tabelas).toEqual([second, first]);
    expect(charts()).toEqual([second, first]);
    expect(engine.txLog.some((attempt) => attempt.phase === 'abort')).toBe(true);
  });

  it('accepts structural equality with reordered object keys', async () => {
    const reordered = {
      rows: CHART.rows,
      domain_id: CHART.domain_id,
      nome: CHART.nome,
      id: CHART.id,
    };
    await expect(save({ ...CHART, nome: 'Editada' }, 0, reordered)).resolves.toMatchObject({
      index: 0,
    });
  });

  it.each([
    ['01', '1'],
    ['90,5', '90,50'],
  ])(
    'keeps the near-miss %s and %s distinct even with the same chart id',
    async (opened, current) => {
      const original = {
        ...CHART,
        rows: [{ id: 'ML-1:1', attributes: [{ id: 'SIZE', value_name: opened }] }],
      };
      document = baseDocument([
        {
          ...original,
          rows: [{ id: 'ML-1:1', attributes: [{ id: 'SIZE', value_name: current }] }],
        },
      ]);
      await expect(save(original, 0, original)).rejects.toBeInstanceOf(SizeChartConflictError);
      expect(committed).toHaveLength(0);
    },
  );

  it.each(['invalid', { tabelas: 'invalid' }, { tabelas: [{ id: 42 }] }])(
    'refuses a malformed legacy account entry without dropping it: %j',
    async (entry) => {
      document = { ...baseDocument(), tabelasDeMedidasMercadoLivre: { [CONTA]: entry } };
      const before = structuredClone(document);
      await expect(save(CHART, null)).rejects.toBeInstanceOf(SizeChartConflictError);
      expect(document).toEqual(before);
      expect(committed).toHaveLength(0);
    },
  );

  it.each([undefined, null, {}])('appends a draft when the marketplace map is %j', async (map) => {
    document = { ...baseDocument(), tabelasDeMedidasMercadoLivre: map };
    const result = await save({ nome: 'Rascunho', id: null }, null);
    expect(result.index).toBe(0);
    expect(charts()).toEqual([{ nome: 'Rascunho', id: null }]);
  });

  it('refuses a table that was already deleted', async () => {
    document = undefined;
    await expect(save(CHART, null)).rejects.toBeInstanceOf(SizeChartConflictError);
    expect(document).toBeUndefined();
    expect(committed).toHaveLength(0);
  });
});
