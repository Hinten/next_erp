import { describe, expect, it } from 'vitest';
import {
  estoqueMercadoLivreSyncMeta,
  estoqueMercadoLivreSyncSchema,
} from './estoqueMercadoLivreSync';
import { ALL_DOMAINS } from './registry';

describe('estoqueMercadoLivreSyncSchema', () => {
  it('parses an empty doc with all defaults (conta never swept)', () => {
    expect(estoqueMercadoLivreSyncSchema.parse({})).toEqual({
      cursorUs: null,
      lastSweepAtUs: null,
      lastDailyAtUs: null,
      lastError: null,
      lastErrorAtUs: null,
      pausedUntilUs: null,
      pauseCount: 0,
      continuacao: null,
    });
  });

  it('round-trips a healthy post-sweep state doc (µs values preserved)', () => {
    const doc = {
      cursorUs: 1721800800000000,
      lastSweepAtUs: 1721801100000000,
      lastDailyAtUs: 1721764800000000,
      lastError: null,
      lastErrorAtUs: null,
      pausedUntilUs: null,
      pauseCount: 0,
      continuacao: null,
    };
    expect(estoqueMercadoLivreSyncSchema.parse(doc)).toEqual(doc);
  });

  it('round-trips a failed-sweep doc (lastError set, cursor NOT advanced)', () => {
    const doc = {
      cursorUs: null,
      lastSweepAtUs: 1721801100000000,
      lastDailyAtUs: null,
      lastError: 'Conta multiorigem (warehouse_management) — envio de estoque recusado.',
      lastErrorAtUs: 1721801100000000,
      pausedUntilUs: null,
      pauseCount: 0,
      continuacao: null,
    };
    expect(estoqueMercadoLivreSyncSchema.parse(doc)).toEqual(doc);
  });

  it('round-trips a 429-paused doc (pausedUntilUs + pauseCount set by the send handler)', () => {
    const doc = {
      cursorUs: 1721800800000000,
      lastSweepAtUs: 1721801100000000,
      lastDailyAtUs: null,
      lastError: null,
      lastErrorAtUs: null,
      pausedUntilUs: 1721801400000000,
      pauseCount: 3,
      continuacao: null,
    };
    expect(estoqueMercadoLivreSyncSchema.parse(doc)).toEqual(doc);
  });

  it('round-trips a TRUNCATED sweep doc (continuacao frozen, cursor NOT advanced)', () => {
    const doc = {
      cursorUs: 1721800800000000,
      lastSweepAtUs: null,
      lastDailyAtUs: null,
      lastError: null,
      lastErrorAtUs: null,
      pausedUntilUs: null,
      pauseCount: 0,
      continuacao: {
        afterAnchorId: 'PROD-42',
        changedSinceMs: 1721800780000,
        modo: 'incremental',
        startedAtUs: 1721801100000000,
      },
    };
    expect(estoqueMercadoLivreSyncSchema.parse(doc)).toEqual(doc);
  });

  it('a DAILY continuation records modo explicitly (never inferred from a sibling field)', () => {
    const parsed = estoqueMercadoLivreSyncSchema.parse({
      continuacao: {
        afterAnchorId: 'PROD-7',
        changedSinceMs: 1721715000000,
        modo: 'daily',
        startedAtUs: 1721801100000000,
      },
    });
    expect(parsed.continuacao).toEqual({
      afterAnchorId: 'PROD-7',
      changedSinceMs: 1721715000000,
      modo: 'daily',
      startedAtUs: 1721801100000000,
    });
  });

  it('rejects a continuacao with an unknown modo', () => {
    expect(() =>
      estoqueMercadoLivreSyncSchema.parse({
        continuacao: {
          afterAnchorId: 'PROD-7',
          changedSinceMs: 1,
          modo: 'reconciliacao',
          startedAtUs: 2,
        },
      }),
    ).toThrow();
  });

  it('rejects a continuacao with an empty afterAnchorId (no keyset position)', () => {
    expect(() =>
      estoqueMercadoLivreSyncSchema.parse({
        continuacao: {
          afterAnchorId: '',
          changedSinceMs: 1,
          modo: 'daily',
          startedAtUs: 2,
        },
      }),
    ).toThrow();
  });
});

describe('estoqueMercadoLivreSyncMeta', () => {
  it('targets the top-level estoqueMercadoLivreSync collection with 0n perms', () => {
    expect(estoqueMercadoLivreSyncMeta.collectionPath).toBe('estoqueMercadoLivreSync');
    expect(estoqueMercadoLivreSyncMeta.permissions).toEqual({
      read: 0n,
      write: 0n,
      delete: 0n,
    });
  });
});

describe('estoqueMercadoLivreSync admin-only registration', () => {
  it('is NOT registered in ALL_DOMAINS (server-only sweep state doc)', () => {
    const domainSchemas = ALL_DOMAINS.map((d) => d.schema);
    expect(domainSchemas).not.toContain(estoqueMercadoLivreSyncSchema);
    const collectionPaths = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    expect(collectionPaths).not.toContain(estoqueMercadoLivreSyncMeta.collectionPath);
  });
});
