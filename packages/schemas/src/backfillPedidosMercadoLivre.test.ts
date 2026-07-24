import { describe, expect, it } from 'vitest';
import {
  backfillPedidosMercadoLivreMeta,
  backfillPedidosMercadoLivreSchema,
} from './backfillPedidosMercadoLivre';
import { ALL_DOMAINS } from './registry';

describe('backfillPedidosMercadoLivreSchema', () => {
  it('parses an empty doc with all defaults (conta never swept)', () => {
    expect(backfillPedidosMercadoLivreSchema.parse({})).toEqual({
      cursorUs: null,
      lastSweepAtUs: null,
      lastError: null,
    });
  });

  it('round-trips a post-sweep cursor doc (µs values preserved)', () => {
    const doc = {
      cursorUs: 1718003600000000,
      lastSweepAtUs: 1718003900000000,
      lastError: null,
    };
    expect(backfillPedidosMercadoLivreSchema.parse(doc)).toEqual(doc);
  });

  it('round-trips a failed-sweep doc (lastError set, cursor NOT advanced)', () => {
    const doc = {
      cursorUs: null,
      lastSweepAtUs: 1718003900000000,
      lastError: 'Token do Mercado Livre inválido. Reconecte a conta.',
    };
    expect(backfillPedidosMercadoLivreSchema.parse(doc)).toEqual(doc);
  });
});

describe('backfillPedidosMercadoLivreMeta', () => {
  it('targets the top-level backfillPedidosMercadoLivre collection with 0n perms', () => {
    expect(backfillPedidosMercadoLivreMeta.collectionPath).toBe('backfillPedidosMercadoLivre');
    expect(backfillPedidosMercadoLivreMeta.permissions).toEqual({
      read: 0n,
      write: 0n,
      delete: 0n,
    });
  });
});

describe('backfillPedidosMercadoLivre admin-only registration', () => {
  it('is NOT registered in ALL_DOMAINS (server-only sweep cursor doc)', () => {
    const domainSchemas = ALL_DOMAINS.map((d) => d.schema);
    expect(domainSchemas).not.toContain(backfillPedidosMercadoLivreSchema);
    const collectionPaths = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    expect(collectionPaths).not.toContain(backfillPedidosMercadoLivreMeta.collectionPath);
  });
});
