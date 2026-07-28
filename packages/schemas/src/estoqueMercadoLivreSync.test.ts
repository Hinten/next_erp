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
    };
    expect(estoqueMercadoLivreSyncSchema.parse(doc)).toEqual(doc);
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
