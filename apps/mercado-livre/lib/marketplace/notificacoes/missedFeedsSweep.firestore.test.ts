import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { missedFeedsMercadoLivreCollection } from '@delfrance/data/admin/collections';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { recordMissedFeedsHealth, type MissedFeedsSweepResult } from './missedFeedsSweep';

function result(appId: string, complete: boolean): MissedFeedsSweepResult {
  return {
    enabled: true,
    configured: true,
    appId,
    complete,
    selectedIntegracaoId: 'diagnostic-only',
    examined: 1,
    rejected: 0,
    queryMode: 'unfiltered',
    streams: [],
    errors: complete ? [] : ['ML_HTTP_500'],
    topicosPulados: {},
    httpCodes: {},
    healthRecorded: false,
  };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('app missed-feeds health (Firestore)', () => {
  it('keeps the newest concurrent attempt and preserves the previous success on failure', async () => {
    const db = getAdminFirestore();
    const appId = 'e2e-1292-' + randomUUID();
    const ref = missedFeedsMercadoLivreCollection.docRef(db, {}, 'app-' + appId);
    try {
      await recordMissedFeedsHealth(db, result(appId, true), 1_700_000_000_000_000);
      expect((await ref.get()).exists).toBe(true);
      await Promise.all([
        recordMissedFeedsHealth(db, result(appId, true), 1_700_000_000_001_000),
        recordMissedFeedsHealth(db, result(appId, false), 1_700_000_000_002_000),
      ]);
      const health = (await ref.get()).data();
      expect(health).toMatchObject({
        lastSweepAtUs: 1_700_000_000_002_000,
        complete: false,
        lastError: 'ML_HTTP_500',
      });
      expect([1_700_000_000_000_000, 1_700_000_000_001_000]).toContain(health?.lastSuccessAtUs);
      expect(await recordMissedFeedsHealth(db, result(appId, true), 1_700_000_000_001_000)).toBe(
        false,
      );
      expect((await ref.get()).data()).toEqual(health);
    } finally {
      await ref.delete();
    }
  });
});
