import { describe, expect, it } from 'vitest';
import {
  missedFeedsMercadoLivreMeta,
  missedFeedsMercadoLivreSchema,
} from './missedFeedsMercadoLivre';
import { ALL_DOMAINS } from './registry';

describe('missedFeedsMercadoLivreSchema', () => {
  it('parses an empty doc with all defaults (conta never swept)', () => {
    expect(missedFeedsMercadoLivreSchema.parse({})).toEqual({
      lastSweepAtUs: null,
      lastError: null,
      lastFoundCount: null,
      lastEnqueuedCount: null,
      lastSkippedCount: null,
      lastTruncated: null,
    });
  });

  it('round-trips a clean-sweep doc (µs values preserved)', () => {
    const doc = {
      lastSweepAtUs: 1718003900000000,
      lastError: null,
      lastFoundCount: 7,
      lastEnqueuedCount: 5,
      lastSkippedCount: 2,
      lastTruncated: false,
    };
    expect(missedFeedsMercadoLivreSchema.parse(doc)).toEqual(doc);
  });

  it('round-trips a contained-error doc (counters left null)', () => {
    const doc = {
      lastSweepAtUs: 1718003900000000,
      lastError: 'Token do Mercado Livre inválido. Reconecte a conta.',
      lastFoundCount: null,
      lastEnqueuedCount: null,
      lastSkippedCount: null,
      lastTruncated: null,
    };
    expect(missedFeedsMercadoLivreSchema.parse(doc)).toEqual(doc);
  });

  it('round-trips a TRUNCATED doc — capacity signal, lastError stays null', () => {
    const parsed = missedFeedsMercadoLivreSchema.parse({
      lastSweepAtUs: 1718003900000000,
      lastError: null,
      lastFoundCount: 1000,
      lastEnqueuedCount: 1000,
      lastSkippedCount: 0,
      lastTruncated: true,
    });
    expect(parsed.lastTruncated).toBe(true);
    expect(parsed.lastError).toBeNull();
  });

  it('carries NO cursor field — the absence is the design (#812)', () => {
    // `GET /missed_feeds` has no time filter, and an entry is filed ~1h after
    // ML gives up, so a `sent`-based cursor advanced at 05:00 would permanently
    // skip an entry sent at 04:55. Retention (48h) vs schedule period (24h) is
    // what guarantees coverage instead. If this ever fails, someone re-added a
    // cursor and must re-read the schema docstring first.
    expect(Object.keys(missedFeedsMercadoLivreSchema.shape)).not.toContain('cursorUs');
  });
});

describe('missedFeedsMercadoLivreMeta', () => {
  it('targets the top-level missedFeedsMercadoLivre collection with 0n perms', () => {
    expect(missedFeedsMercadoLivreMeta.collectionPath).toBe('missedFeedsMercadoLivre');
    expect(missedFeedsMercadoLivreMeta.permissions).toEqual({
      read: 0n,
      write: 0n,
      delete: 0n,
    });
  });

  it('does NOT start with "notificacoes" — that prefix trips guards B and C', () => {
    // `notificationGuardrails.test.ts` demands a `defineNotificationPipeline`
    // consumer and a `(status, processedAt)` index for any admin collection
    // whose path starts with `notificacoes`. This one is a health record, not a
    // notification store, and has neither.
    expect(missedFeedsMercadoLivreMeta.collectionPath.startsWith('notificacoes')).toBe(false);
  });
});

describe('missedFeedsMercadoLivre admin-only registration', () => {
  it('is NOT registered in ALL_DOMAINS (server-only sweep health doc)', () => {
    const domainSchemas = ALL_DOMAINS.map((d) => d.schema);
    expect(domainSchemas).not.toContain(missedFeedsMercadoLivreSchema);
    const collectionPaths = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    expect(collectionPaths).not.toContain(missedFeedsMercadoLivreMeta.collectionPath);
  });
});
