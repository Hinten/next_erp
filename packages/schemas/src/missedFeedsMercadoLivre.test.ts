import { describe, expect, it } from 'vitest';
import { missedFeedsMercadoLivreMeta, missedFeedsMercadoLivreSchema } from './missedFeedsMercadoLivre';
import { ALL_DOMAINS } from './registry';

describe('missedFeedsMercadoLivreSchema', () => {
  it('defaults an unswept diagnostic to incomplete with no successful run', () => {
    expect(missedFeedsMercadoLivreSchema.parse({})).toEqual({
      appId: null, selectedIntegracaoId: null, complete: false, streams: [],
      lastSweepAtUs: null, lastSuccessAtUs: null, lastError: null,
      lastFoundCount: null, lastEnqueuedCount: null, lastSkippedCount: null, lastTruncated: null,
    });
  });
  it('retains old diagnostic rows without interpreting them as app success', () => {
    const parsed = missedFeedsMercadoLivreSchema.parse({ lastSweepAtUs: 1718003900000000, lastFoundCount: 7 });
    expect(parsed).toMatchObject({ lastSweepAtUs: 1718003900000000, appId: null, complete: false, lastSuccessAtUs: null });
  });
  it('round-trips application health and stream coverage in microseconds', () => {
    const doc = missedFeedsMercadoLivreSchema.parse({
      appId: '42', selectedIntegracaoId: 'owner', complete: true,
      lastSweepAtUs: 1718003900000000, lastSuccessAtUs: 1718003900000000,
      streams: [{ topic: 'items', siteId: 'MLB', pages: 1, found: 0, novos: 0,
        enqueued: 0, skippedTopic: 0, skippedIgnorado: 0, skippedInvalid: 0,
        complete: true, truncated: false, error: null }],
    });
    expect(doc.lastSuccessAtUs).toBe(1718003900000000);
    expect(missedFeedsMercadoLivreSchema.parse(doc)).toEqual(doc);
  });
  it('has no feed cursor', () => {
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
