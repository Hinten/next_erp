/**
 * `createTokenDuravelStore` against a REAL Firestore (the emulator lane).
 *
 * `tokenStore.test.ts` already covers `getOrRefreshAccessToken`'s branching
 * against an in-memory `fakeStore` whose `loadValid` replays a scripted
 * `validSeq` array. That is a good test of the LOGIC — but the sequence is the
 * test telling itself what the race looked like, and the Firestore-backed store
 * that has to actually produce it (`createTokenDuravelStore`) has no test at
 * all. This file covers exactly that gap and nothing else: the store's real
 * query/write semantics, and the "one wins" convergence driven by real write
 * latency rather than a scripted array.
 *
 * Deliberately NOT re-tested here (tokenStore.test.ts owns them, with no
 * Firestore needed): `tokenDuravelFromResponse` mapping, the fast path, the
 * no-credential throw, the two-re-read backoff call counts.
 *
 * ⚠️ `db` comes from the PRODUCTION accessor `getAdminFirestore()`, never a
 * local copy — that puts the project/database wiring itself under test. In the
 * emulator a mis-targeted database silently exists and auto-creates (unlike
 * production, where `(default)` fails every op with `5 NOT_FOUND`), so every
 * `it` below carries at least one POSITIVE existence assertion. A file made
 * only of "empty"/"not found" assertions passes identically against the wrong
 * database.
 */
import { randomUUID } from 'node:crypto';
import type { TokenResponse } from '@delfrance/integrations-mercado-livre';
import {
  type MercadoLivreOAuthConfig,
  MercadoLivreReauthRequiredError,
} from '@delfrance/integrations-mercado-livre';
import type { TokenDuravel } from '@delfrance/schemas';
import { describe, expect, it, vi } from 'vitest';

import { getAdminFirestore } from '@/lib/firebase/admin';

import {
  REFRESH_SKEW_MS,
  type TokenDuravelStore,
  createTokenDuravelStore,
  getOrRefreshAccessToken,
} from './tokenStore';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

/** Fixed clock: every `now`/`expires_in` below is derived from it. */
const NOW = 1_700_000_000_000;
const CUTOFF = NOW + REFRESH_SKEW_MS;

const config: MercadoLivreOAuthConfig = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  redirectUri: 'https://example.invalid/callback',
};

function tok(over: Partial<TokenDuravel> = {}): TokenDuravel {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    token_type: 'bearer',
    scope: '',
    expires_in: NOW + 3_600_000,
    user_id: null,
    expired: null,
    ...over,
  };
}

function tokenResponse(over: Partial<TokenResponse> = {}): TokenResponse {
  return {
    access_token: 'AT-fresh',
    token_type: 'bearer',
    // 6h — comfortably above REFRESH_SKEW_MS, so the rotated token is `valid`
    // against the pre-POST cutoff the loser re-reads with.
    expires_in: 21_600,
    scope: 'offline_access read write',
    user_id: 7,
    refresh_token: 'RT-rotated',
    ...over,
  };
}

/** A fresh, never-before-used account id — perfect isolation, no teardown. */
function newIntegracaoId(): string {
  return `int${randomUUID().replace(/-/g, '')}`;
}

/**
 * The raw `integracao/{id}/tokenDuravel` collection, UNCONVERTED. Used to seed
 * shapes the strict write-parser would reject — notably the Flutter-written
 * auto-id docs and a doc missing `expires_in`. Same idea as the raw Admin-SDK
 * seeding in apps/functions' storage suite.
 */
function rawColl(integracaoId: string) {
  return getAdminFirestore().collection('integracao').doc(integracaoId).collection('tokenDuravel');
}

describe.skipIf(!EMULATED)('createTokenDuravelStore (Firestore emulator)', () => {
  it('A1: successive saves collapse onto the single `current` doc', async () => {
    const integracaoId = newIntegracaoId();
    const store = createTokenDuravelStore(getAdminFirestore(), integracaoId);

    await store.save(tok({ access_token: 'AT-1', refresh_token: 'RT-1' }));
    await store.save(tok({ access_token: 'AT-2', refresh_token: 'RT-2' }));

    const snap = await rawColl(integracaoId).get();
    expect(snap.docs.map((d) => d.id)).toEqual(['current']);
    expect(snap.docs[0]?.data()).toMatchObject({ access_token: 'AT-2', refresh_token: 'RT-2' });

    // ...and the store reads back what it wrote (read-your-own-write through a
    // query, not just a doc get).
    const latest = await store.loadLatest();
    expect(latest?.access_token).toBe('AT-2');
  });

  it('A2: reads span BOTH doc lineages — a Flutter auto-id doc can outrank `current`', async () => {
    const integracaoId = newIntegracaoId();
    const store = createTokenDuravelStore(getAdminFirestore(), integracaoId);

    // This app's lineage: the fixed `current` doc.
    await store.save(tok({ access_token: 'AT-current', expires_in: NOW + 3_600_000 }));
    // The legacy Flutter app's lineage: an auto-id doc, written straight to the
    // same collection, with a LATER expiry. It must win — the reads are ordered
    // by `expires_in`, never by doc id.
    await rawColl(integracaoId).add(
      tok({ access_token: 'AT-flutter', expires_in: NOW + 7_200_000 }),
    );

    expect((await store.loadLatest())?.access_token).toBe('AT-flutter');
    expect((await store.loadValid(CUTOFF))?.access_token).toBe('AT-flutter');
  });

  it('A2b: deleteAll clears BOTH lineages, leaving no readable credential', async () => {
    const integracaoId = newIntegracaoId();
    const store = createTokenDuravelStore(getAdminFirestore(), integracaoId);

    // Exactly the A2 arrangement — the shape that makes a `current`-only delete
    // look like it worked while a live Flutter refresh_token survives it.
    await store.save(tok({ access_token: 'AT-current' }));
    await rawColl(integracaoId).add(tok({ access_token: 'AT-flutter-1' }));
    await rawColl(integracaoId).add(tok({ access_token: 'AT-flutter-2' }));
    // POSITIVE assertion first: prove the docs are really there, on the database
    // under test, before asserting they are gone.
    expect((await rawColl(integracaoId).get()).size).toBe(3);

    const removed = await store.deleteAll();

    expect(removed).toBe(3);
    expect((await rawColl(integracaoId).get()).empty).toBe(true);
    // The store must now read as disconnected through its own API, not just at
    // the raw collection — this is what the conta panel renders.
    expect(await store.loadLatest()).toBeNull();
    expect(await store.loadValid(CUTOFF)).toBeNull();
    await expect(getOrRefreshAccessToken(store, config, { now: NOW })).rejects.toBeInstanceOf(
      MercadoLivreReauthRequiredError,
    );
  });

  it('A2c: deleteAll on an account with no credential is a no-op, not a throw', async () => {
    // The mint flow calls this after persisting both users; a conta that was
    // never connected must not turn that into a failure.
    const integracaoId = newIntegracaoId();
    const store = createTokenDuravelStore(getAdminFirestore(), integracaoId);

    await expect(store.deleteAll()).resolves.toBe(0);
  });

  it('A2b: `loadValid` is a STRICT `>` — a token expiring exactly at the cutoff is not valid', async () => {
    const integracaoId = newIntegracaoId();
    const store = createTokenDuravelStore(getAdminFirestore(), integracaoId);

    await store.save(tok({ access_token: 'AT-boundary', expires_in: CUTOFF }));

    expect(await store.loadValid(CUTOFF)).toBeNull();
    // Positive counterpart: one millisecond past the cutoff and it IS returned,
    // which proves the null above is the boundary and not an empty collection.
    expect((await store.loadValid(CUTOFF - 1))?.access_token).toBe('AT-boundary');
  });

  it('A3: a doc MISSING `expires_in` is invisible to both reads', async () => {
    const integracaoId = newIntegracaoId();
    const store = createTokenDuravelStore(getAdminFirestore(), integracaoId);

    // Flutter serializes with `includeIfNull: false`, so an absent field is a
    // reachable production shape. Real Firestore excludes docs that lack the
    // `orderBy` field entirely; an in-memory fake that sorts on `?? 0` would
    // happily return this one.
    await rawColl(integracaoId).add({
      access_token: 'AT-no-expiry',
      refresh_token: 'RT-no-expiry',
      token_type: 'bearer',
      scope: '',
    });
    await store.save(tok({ access_token: 'AT-good' }));

    expect((await store.loadLatest())?.access_token).toBe('AT-good');
    expect((await store.loadValid(CUTOFF))?.access_token).toBe('AT-good');
  });

  it('A6: a rotated token is committed and visible to the NEXT call, which takes the fast path', async () => {
    const integracaoId = newIntegracaoId();
    const db = getAdminFirestore();
    const store = createTokenDuravelStore(db, integracaoId);

    await store.save(tok({ access_token: 'AT-stale', refresh_token: 'RT-0', expires_in: NOW - 1 }));

    const refresh = vi.fn(async () => tokenResponse());

    const first = await getOrRefreshAccessToken(store, config, { now: NOW, refresh });
    expect(first).toBe('AT-fresh');

    // A brand-new store instance, to be sure nothing is memoized in the closure.
    const second = await getOrRefreshAccessToken(
      createTokenDuravelStore(db, integracaoId),
      config,
      { now: NOW, refresh },
    );

    expect(second).toBe('AT-fresh');
    // The point: the second call did NOT refresh. That is only true if the
    // rotated token was committed AND visible to a `where`+`orderBy`+`limit`
    // query — not merely present in some in-process array.
    expect(refresh).toHaveBeenCalledTimes(1);

    const stored = await rawColl(integracaoId).doc('current').get();
    expect(stored.exists).toBe(true);
    expect(stored.data()).toMatchObject({
      access_token: 'AT-fresh',
      refresh_token: 'RT-rotated',
    });
  });

  it('A7: two concurrent refreshes — the loser converges on the winner’s committed token', async () => {
    const integracaoId = newIntegracaoId();
    const db = getAdminFirestore();

    await createTokenDuravelStore(db, integracaoId).save(
      tok({ access_token: 'AT-stale', refresh_token: 'RT-0', expires_in: NOW - 1 }),
    );

    // A rendezvous on top of Promise.all. `Promise.all` only guarantees both
    // calls START; in principle racer A could finish end-to-end during racer
    // B's first `loadValid`, leaving B on the fast path having never refreshed.
    // Measured, that does NOT currently happen — both calls issue their first
    // await in the same tick and every step is I/O, so they interleave for
    // free (removing this line keeps the suite green). It is kept because the
    // property we depend on is then a scheduling accident: the barrier makes
    // the overlap a guarantee rather than an observation, so a future change
    // in await shape cannot quietly turn this into a serial test that still
    // passes. The `toHaveBeenCalledTimes(2)` below is what would catch that —
    // verified by forcing serialization, which fails it with 1.
    let arrived = 0;
    let releaseBoth!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });

    let markWinnerSaved!: () => void;
    const winnerSaved = new Promise<void>((resolve) => {
      markWinnerSaved = resolve;
    });

    const refresh = vi.fn(async (_cfg: MercadoLivreOAuthConfig, refreshToken: string) => {
      const turn = ++arrived;
      if (arrived === 2) releaseBoth();
      await bothArrived;
      // ML's single-use rotation IS the arbiter: whoever POSTs the token first
      // rotates it, and the other one gets invalid_grant back.
      if (turn === 1) {
        expect(refreshToken).toBe('RT-0');
        return tokenResponse();
      }
      throw new MercadoLivreReauthRequiredError(
        'refresh_failed',
        'invalid_grant — refresh_token já utilizado',
      );
    });

    /** The REAL store; only `save` is observed, so the write itself is real. */
    function observedStore(): TokenDuravelStore {
      const real = createTokenDuravelStore(db, integracaoId);
      return {
        loadValid: (cutoff) => real.loadValid(cutoff),
        loadLatest: () => real.loadLatest(),
        deleteAll: () => real.deleteAll(),
        async save(fresh) {
          const saved = await real.save(fresh);
          markWinnerSaved();
          return saved;
        },
      };
    }

    // The loser's backoff waits on the winner's ACTUAL commit instead of a
    // 250 ms wall-clock guess — a happens-before edge, not a race with CI load.
    // (A real timer here is the classic "green standalone, red under turbo"
    // flake; a no-op sleep is the same bug inverted.)
    const opts = { now: NOW, refresh, sleep: () => winnerSaved };

    const [a, b] = await Promise.all([
      getOrRefreshAccessToken(observedStore(), config, opts),
      getOrRefreshAccessToken(observedStore(), config, opts),
    ]);

    // THE discriminating assertion: if the two calls serialized, the second
    // would have hit the fast path and this would be 1. Without it the rest of
    // this test passes without ever having raced.
    expect(refresh).toHaveBeenCalledTimes(2);

    // Both callers end up on the winner's token — nobody is handed a dead one.
    expect(a).toBe('AT-fresh');
    expect(b).toBe('AT-fresh');

    // And the winner's rotation is what is actually in Firestore.
    const stored = await rawColl(integracaoId).doc('current').get();
    expect(stored.exists).toBe(true);
    expect(stored.data()).toMatchObject({
      access_token: 'AT-fresh',
      refresh_token: 'RT-rotated',
    });
  });

  it('A8: concurrent saves do not throw — the store is deliberately precondition-free', async () => {
    const integracaoId = newIntegracaoId();
    const store = createTokenDuravelStore(getAdminFirestore(), integracaoId);

    // `save` is a bare `.set()` on a fixed doc id: no transaction, no
    // `lastUpdateTime` precondition, last writer wins. That is deliberate —
    // `runTransaction` retries its callback on contention, which would re-fire
    // the NON-IDEMPOTENT single-use refresh. This pins the absence so that
    // adding a precondition later fails here loudly instead of silently
    // re-POSTing rotations in production.
    await Promise.all([
      store.save(tok({ access_token: 'AT-a', refresh_token: 'RT-a' })),
      store.save(tok({ access_token: 'AT-b', refresh_token: 'RT-b' })),
    ]);

    const snap = await rawColl(integracaoId).get();
    expect(snap.docs.map((d) => d.id)).toEqual(['current']);
    expect(['AT-a', 'AT-b']).toContain(snap.docs[0]?.data().access_token);
  });
});
