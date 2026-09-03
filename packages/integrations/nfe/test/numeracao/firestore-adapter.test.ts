/**
 * Firestore adapter tests — fake Firestore (no live network).
 *
 * The live concurrency contract lives in `numeracao.staging.test.ts`.
 * Here we just confirm the adapter wires the slash-path API correctly
 * and round-trips a config through nfeConfigSchema validation.
 */
import { describe, expect, it } from 'vitest';
import type { NFeConfig } from '@delfrance/schemas';

import { nextIdLote, nextNumeracao } from '../../src/numeracao/index';
import {
  DEFAULT_NFE_CONFIG_DOC_ID,
  nfeConfigStoreFromFirestore,
  type AdminDocRefLike,
  type AdminFirestoreLike,
  type AdminTxLike,
} from '../../src/numeracao/firestore-adapter';
import { AMBIENTE_NFE, CONTINGENCIA_MODO } from '@delfrance/schemas';

/** Fake Firestore — same shape as firebase-admin, in-memory storage. */
function fakeFirestore(seed: Record<string, NFeConfig>): {
  fs: AdminFirestoreLike;
  state: Record<string, Record<string, unknown>>;
  refsRequested: string[];
} {
  const state: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(seed)) state[k] = v as Record<string, unknown>;
  const refsRequested: string[] = [];

  function makeRef(path: string): AdminDocRefLike {
    refsRequested.push(path);
    const id = path.split('/').pop()!;
    return { path, id };
  }

  const fs: AdminFirestoreLike = {
    doc: (path: string) => makeRef(path),
    async runTransaction<T>(fn: (tx: AdminTxLike) => Promise<T>): Promise<T> {
      const pending: Record<string, Record<string, unknown>> = {};
      const tx: AdminTxLike = {
        async get(ref) {
          const data = pending[ref.path] ?? state[ref.path];
          return {
            exists: data != null,
            data: () => data,
          };
        },
        set(ref, data) {
          pending[ref.path] = data;
        },
      };
      const result = await fn(tx);
      Object.assign(state, pending);
      return result;
    },
  };

  return { fs, state, refsRequested };
}

const SEED: NFeConfig = {
  numeracao_atual: 0,
  serie: 1,
  idLote: 0,
  ambiente: AMBIENTE_NFE.homologacao,
  contingencia_modo: CONTINGENCIA_MODO.none,
  contingencia_justificativa: null,
  contingencia_dataInicio: null,
  emitirReformaTributaria: false,
  timestamp: null,
};

describe('nfeConfigStoreFromFirestore', () => {
  it('reads + writes the canonical filiais/{id}/nfeconfig/default path', async () => {
    const { fs, state, refsRequested } = fakeFirestore({
      'filiais/F-1/nfeconfig/default': SEED,
    });
    const store = nfeConfigStoreFromFirestore(fs);
    const r = await nextNumeracao(store, 'F-1');
    expect(r.nNF).toBe(1);
    expect(state['filiais/F-1/nfeconfig/default']?.numeracao_atual).toBe(1);
    expect(refsRequested).toContain('filiais/F-1/nfeconfig/default');
  });

  it('honors a custom configDocId', async () => {
    const { fs, state } = fakeFirestore({
      'filiais/F-1/nfeconfig/custom-tenant-A': SEED,
    });
    const store = nfeConfigStoreFromFirestore(fs, { configDocId: 'custom-tenant-A' });
    await nextNumeracao(store, 'F-1');
    expect(state['filiais/F-1/nfeconfig/custom-tenant-A']?.numeracao_atual).toBe(1);
    // Default path was NOT touched.
    expect(state['filiais/F-1/nfeconfig/default']).toBeUndefined();
  });

  // ⚠️ The seeded `timestamp` is a STRING, and so is the one this asserts on,
  // because that is what `firestore-adapter.ts`'s `set()` actually writes
  // (`new Date().toISOString()`) — while `nfeConfigSchema` declares the field
  // as `millisSinceEpoch()`, i.e. a NUMBER. Nothing fails today only because
  // that reader is tolerant: `z.preprocess(tolerant(coerceToMillis), ...)`
  // coerces the ISO string back to millis on the way in, so the disagreement is
  // invisible at runtime and was invisible to tsc too — this file was outside
  // the package's tsconfig `include` until #1445's follow-up.
  //
  // Left as-is deliberately: changing what the adapter STORES is a data-shape
  // change to documents that already exist, which this repo wants handled by a
  // one-time migration and its own issue, not by a lint PR. The cast keeps the
  // test honest about current behaviour instead of asserting an intent the code
  // does not implement.
  it('stamps a timestamp on every write', async () => {
    const { fs, state } = fakeFirestore({
      'filiais/F-1/nfeconfig/default': {
        ...SEED,
        timestamp: '2025-01-01T00:00:00Z',
      } as unknown as NFeConfig,
    });
    const store = nfeConfigStoreFromFirestore(fs);
    await nextIdLote(store, 'F-1');
    const written = state['filiais/F-1/nfeconfig/default'];
    expect(typeof written?.timestamp).toBe('string');
    expect(written?.timestamp).not.toBe('2025-01-01T00:00:00Z'); // updated
  });

  it('runs an unknown filial through the not-found error path', async () => {
    const { fs } = fakeFirestore({});
    const store = nfeConfigStoreFromFirestore(fs);
    await expect(nextNumeracao(store, 'UNKNOWN')).rejects.toThrow(/NFeConfig not found/);
  });

  it('exports the default configDocId', () => {
    expect(DEFAULT_NFE_CONFIG_DOC_ID).toBe('default');
  });
});
