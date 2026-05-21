/**
 * Numeração library tests — in-memory mock store.
 *
 * The fiscal-critical guarantees (no duplicates, no gaps under
 * concurrent load) live in `numeracao.staging.test.ts` (env-gated,
 * real Firestore). These offline tests cover correctness of the
 * single-call paths + the failure modes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NFeConfig } from '@delfrance/schemas';

import {
  NFeBulkSizeError,
  NFeConfigNotFoundError,
  nextIdLote,
  nextNumeracao,
  nextNumeracaoBulk,
  readNFeConfig,
  type NFeConfigStore,
  type NFeConfigTx,
} from '../../src/numeracao/index';

/**
 * In-memory store backed by a Map. `runTransaction` serialises calls
 * via an async queue so two concurrent invocations don't see each
 * other's writes — same atomicity guarantee Firestore offers.
 */
function makeInMemoryStore(seed: Record<string, NFeConfig>): {
  store: NFeConfigStore;
  state: Map<string, NFeConfig>;
} {
  const state = new Map<string, NFeConfig>(Object.entries(seed));
  let queue: Promise<unknown> = Promise.resolve();
  const store: NFeConfigStore = {
    runTransaction: <T>(fn: (tx: NFeConfigTx) => Promise<T>) => {
      const ran = queue.then(() => {
        // Snapshot at the start of the tx — writes only land at commit.
        const pending = new Map<string, NFeConfig>();
        const tx: NFeConfigTx = {
          async get(filialId) {
            return pending.get(filialId) ?? state.get(filialId) ?? null;
          },
          set(filialId, next) {
            pending.set(filialId, next);
          },
        };
        return fn(tx).then((result) => {
          for (const [k, v] of pending) state.set(k, v);
          return result;
        });
      });
      queue = ran.catch(() => {}); // tail keeps moving even after rejections
      return ran as Promise<T>;
    },
  };
  return { store, state };
}

const SEED: NFeConfig = {
  numeracao_atual: 0,
  serie: 1,
  idLote: 0,
  ambiente: '2',
};

const FILIAL = 'F-1';

describe('nextNumeracao', () => {
  let store: NFeConfigStore;
  let state: Map<string, NFeConfig>;
  beforeEach(() => {
    ({ store, state } = makeInMemoryStore({ [FILIAL]: { ...SEED } }));
  });

  it('returns numeracao_atual + 1 and persists the new value', async () => {
    const r1 = await nextNumeracao(store, FILIAL);
    expect(r1).toEqual({ nNF: 1, serie: 1 });
    expect(state.get(FILIAL)?.numeracao_atual).toBe(1);

    const r2 = await nextNumeracao(store, FILIAL);
    expect(r2).toEqual({ nNF: 2, serie: 1 });
    expect(state.get(FILIAL)?.numeracao_atual).toBe(2);
  });

  it('returns the filial-configured serie alongside the nNF', async () => {
    state.set(FILIAL, { ...SEED, serie: 5 });
    const r = await nextNumeracao(store, FILIAL);
    expect(r.serie).toBe(5);
  });

  it('throws NFeConfigNotFoundError when the filial has no config', async () => {
    await expect(nextNumeracao(store, 'UNKNOWN')).rejects.toBeInstanceOf(
      NFeConfigNotFoundError,
    );
  });

  it('serialises concurrent calls — no duplicates, no gaps', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => nextNumeracao(store, FILIAL)),
    );
    const nNFs = results.map((r) => r.nNF).sort((a, b) => a - b);
    expect(new Set(nNFs).size).toBe(20); // no duplicates
    expect(nNFs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1)); // 1..20
    expect(state.get(FILIAL)?.numeracao_atual).toBe(20);
  });
});

describe('nextNumeracaoBulk', () => {
  let store: NFeConfigStore;
  let state: Map<string, NFeConfig>;
  beforeEach(() => {
    ({ store, state } = makeInMemoryStore({ [FILIAL]: { ...SEED } }));
  });

  it('returns a contiguous range and bumps numeracao_atual by `count`', async () => {
    const r = await nextNumeracaoBulk(store, FILIAL, 5);
    expect(r.nNFs).toEqual([1, 2, 3, 4, 5]);
    expect(r.serie).toBe(1);
    expect(state.get(FILIAL)?.numeracao_atual).toBe(5);
  });

  it('continues across calls with no gaps', async () => {
    const a = await nextNumeracaoBulk(store, FILIAL, 3);
    const b = await nextNumeracaoBulk(store, FILIAL, 2);
    expect([...a.nNFs, ...b.nNFs]).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects count < 1', async () => {
    await expect(nextNumeracaoBulk(store, FILIAL, 0)).rejects.toBeInstanceOf(NFeBulkSizeError);
    await expect(nextNumeracaoBulk(store, FILIAL, -1)).rejects.toBeInstanceOf(NFeBulkSizeError);
  });

  it('rejects non-integer count', async () => {
    await expect(nextNumeracaoBulk(store, FILIAL, 2.5)).rejects.toBeInstanceOf(NFeBulkSizeError);
  });

  it('throws NFeConfigNotFoundError when the filial has no config', async () => {
    await expect(nextNumeracaoBulk(store, 'UNKNOWN', 5)).rejects.toBeInstanceOf(
      NFeConfigNotFoundError,
    );
  });

  it('serialises parallel bulks — no overlapping ranges', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => nextNumeracaoBulk(store, FILIAL, 5)),
    );
    const allNNFs = results.flatMap((r) => r.nNFs).sort((a, b) => a - b);
    expect(new Set(allNNFs).size).toBe(50); // no duplicates across 10 batches of 5
    expect(allNNFs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

describe('nextIdLote', () => {
  let store: NFeConfigStore;
  let state: Map<string, NFeConfig>;
  beforeEach(() => {
    ({ store, state } = makeInMemoryStore({ [FILIAL]: { ...SEED } }));
  });

  it('returns idLote + 1 and persists', async () => {
    expect(await nextIdLote(store, FILIAL)).toBe(1);
    expect(await nextIdLote(store, FILIAL)).toBe(2);
    expect(state.get(FILIAL)?.idLote).toBe(2);
  });

  it('is independent of nNF — interleaved calls advance different counters', async () => {
    const nNFa = await nextNumeracao(store, FILIAL);
    const lote1 = await nextIdLote(store, FILIAL);
    const nNFb = await nextNumeracao(store, FILIAL);
    const lote2 = await nextIdLote(store, FILIAL);
    expect(nNFa.nNF).toBe(1);
    expect(nNFb.nNF).toBe(2);
    expect(lote1).toBe(1);
    expect(lote2).toBe(2);
  });

  it('throws NFeConfigNotFoundError when the filial has no config', async () => {
    await expect(nextIdLote(store, 'UNKNOWN')).rejects.toBeInstanceOf(NFeConfigNotFoundError);
  });

  it('serialises concurrent calls — no duplicates, no gaps', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => nextIdLote(store, FILIAL)));
    const sorted = [...results].sort((a, b) => a - b);
    expect(new Set(sorted).size).toBe(20);
    expect(sorted).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe('readNFeConfig', () => {
  it('returns the current config without advancing any counter', async () => {
    const { store, state } = makeInMemoryStore({
      [FILIAL]: { ...SEED, numeracao_atual: 42, idLote: 7, serie: 3 },
    });
    const cfg = await readNFeConfig(store, FILIAL);
    expect(cfg.numeracao_atual).toBe(42);
    expect(cfg.idLote).toBe(7);
    expect(cfg.serie).toBe(3);
    // No mutation.
    expect(state.get(FILIAL)?.numeracao_atual).toBe(42);
    expect(state.get(FILIAL)?.idLote).toBe(7);
  });

  it('throws NFeConfigNotFoundError when the filial has no config', async () => {
    const { store } = makeInMemoryStore({});
    await expect(readNFeConfig(store, FILIAL)).rejects.toBeInstanceOf(NFeConfigNotFoundError);
  });
});
