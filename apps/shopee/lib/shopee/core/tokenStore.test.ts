/**
 * The leased refresh, tested at three altitudes.
 *
 *  1. **The three transactions** against a `FakeDb` wired to the shared
 *     `OccEngine` (`@delfrance/data/testing`), with the REAL collection handle —
 *     so `credenciaisIntegracaoSchema` actually runs on every patch and a blank
 *     `refresh_token` fails here exactly as it would in production.
 *  2. **The flow** end to end over that same fake, with the provider call
 *     injected. This is where "the pair is stored before the token is returned"
 *     and "at most one provider call" are observable.
 *  3. **The poll loop** over an in-memory port double, where a lease can be held
 *     forever without anything having to hold it.
 *
 * ⚠️ Every boundary here is written as a PAIR: the case that crosses it and the
 * near miss that does not. A test that a fold or a comparison APPLIES cannot
 * show where it STOPS (root CLAUDE.md), and every guard in this file is one
 * inequality or one identity comparison away from being vacuous.
 *
 * ⚠️ Token values are obviously fake (`at-1`, `rt-1`, shop 220099) and no test
 * title, log assertion or comment carries a real one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OccEngine, type OccTransaction, deferred } from '@delfrance/data/testing';
import {
  ShopeeApiError,
  ShopeeNetworkError,
  type ShopeeOAuthConfig,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  type ShopeeRefreshSubject,
  type ShopeeTokenPair,
  resolveShopeeHosts,
} from '@delfrance/integrations-shopee';

import {
  EXPIRY_GUARD_MS,
  ShopeeCredencialInvalidaError,
  credentialFromTokenPair,
} from './credentialStore';
import {
  type AcquireOutcome,
  type CommitOutcome,
  type FalhaRefresh,
  REFRESH_LEASE_TTL_MS,
  REFRESH_POLL_BUDGET_MS,
  REFRESH_POLL_INTERVAL_MS,
  REFRESH_SKEW_MS,
  type ReleaseOutcome,
  ShopeeRefreshEmAndamentoError,
  ShopeeSemCredencialError,
  type ShopeeLeasedTokenStore,
  createShopeeTokenStore,
  getOrRefreshAccessToken,
} from './tokenStore';

/* -------------------------------------------------------------------------- */
/*                                  Fixtures                                  */
/* -------------------------------------------------------------------------- */

const INTEGRACAO_ID = 'int-1';
const DOC_PATH = `integracao/${INTEGRACAO_ID}/credenciais/current`;
const SHOP_ID = 220099;
const SUBJECT: ShopeeRefreshSubject = { kind: 'shop', shopId: SHOP_ID };

const CONFIG: ShopeeOAuthConfig = {
  partnerId: 1234567,
  partnerKey: 'chave-de-teste',
  hosts: resolveShopeeHosts({ sandbox: true }),
};

/** An arbitrary but fixed instant, so every clock arithmetic below is readable. */
const T0 = 1_700_000_000_000;

/** The pair Shopee answers with in these tests. Never a real token. */
const PAR_NOVO: ShopeeTokenPair = {
  accessToken: 'at-2',
  refreshToken: 'rt-2',
  expiresAtMs: T0 + 4 * 60 * 60 * 1000,
  requestId: 'req-2',
  shopIdList: null,
  merchantIdList: null,
};

type Doc = Record<string, unknown>;

/** A stored credential whose access token has `restante` ms of life left. */
function credencial(restante: number, extra: Doc = {}): Doc {
  return {
    access_token: 'at-1',
    refresh_token: 'rt-1',
    expirationDate: T0 + restante,
    provider: 'shopee',
    shop_id: SHOP_ID,
    obtidoEm: T0 - 1,
    ...extra,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   FakeDb                                   */
/* -------------------------------------------------------------------------- */

/**
 * A single-document store with the ref shape `defineAdminCollection` builds
 * through, so the REAL `credenciaisIntegracaoCollection` handle can be used
 * unmocked. Transaction semantics come from the shared `OccEngine`, so this
 * class models storage and nothing else.
 */
class FakeDb {
  private readonly docs = new Map<string, Doc>();
  /** Every read and write, in call order — the ordering proofs read this. */
  readonly opLog: { op: string; path: string }[] = [];

  readonly occ = new OccEngine({
    applyWrite: (kind, path, data) => {
      if (kind === 'update' && !this.docs.has(path)) {
        const err = new Error(`NOT_FOUND: ${path}`) as Error & { code: number };
        err.code = 5;
        throw err;
      }
      if (kind === 'update') this.docs.set(path, { ...this.docs.get(path), ...data });
      else this.docs.set(path, { ...data });
    },
    logWrite: (op, path) => {
      this.opLog.push({ op, path });
    },
  });

  /** The shape `xCollection.docRef(db, ctx, id)` resolves through. */
  readonly collection = (path: string) => ({
    doc: (id: string) => this.refFor(`${path}/${id}`),
  });

  private refFor(path: string) {
    return {
      path,
      get: async () => {
        this.opLog.push({ op: 'get', path });
        const data = this.docs.get(path);
        return { exists: data !== undefined, data: () => data };
      },
    };
  }

  /** Seed or replace a document without going through a transaction. */
  seed(path: string, doc: Doc | null): void {
    if (doc === null) this.docs.delete(path);
    else this.docs.set(path, { ...doc });
  }

  read(path: string): Doc | undefined {
    return this.docs.get(path);
  }

  async runTransaction<T>(fn: (tx: OccTransaction) => Promise<T>): Promise<T> {
    return this.occ.runTransaction(fn);
  }
}

function novoStore(db: FakeDb): ShopeeLeasedTokenStore {
  return createShopeeTokenStore(db as never, INTEGRACAO_ID);
}

let spyWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/* -------------------------------------------------------------------------- */
/*                               The constants                                */
/* -------------------------------------------------------------------------- */

describe('the lease constants', () => {
  it('keeps the invariant BUDGET < TTL < SKEW', () => {
    // ⚠️ Both inequalities are load-bearing, and the direction of each is a
    // different failure. TTL >= SKEW: a crashed refresher's lease outlives the
    // token it was renewing, so the conta stops working before anyone may take
    // over. BUDGET >= TTL: a caller that waited out the budget would be taking
    // over a lease that is still LIVE, re-spending a single-use refresh token —
    // the pair-burning case the lease exists to prevent.
    expect(REFRESH_POLL_BUDGET_MS).toBeLessThan(REFRESH_LEASE_TTL_MS);
    expect(REFRESH_LEASE_TTL_MS).toBeLessThan(REFRESH_SKEW_MS);
    expect(REFRESH_POLL_INTERVAL_MS).toBeGreaterThan(0);
    expect(REFRESH_POLL_INTERVAL_MS).toBeLessThan(REFRESH_POLL_BUDGET_MS);
  });
});

/* -------------------------------------------------------------------------- */
/*                          Transaction 1 — acquire                           */
/* -------------------------------------------------------------------------- */

describe('acquire — the lease claim (class A)', () => {
  async function acquire(db: FakeDb, owner = 'owner-a', now = T0): Promise<AcquireOutcome> {
    return novoStore(db).acquire(owner, now, REFRESH_LEASE_TTL_MS, REFRESH_SKEW_MS);
  }

  it('answers `ausente` for a conta that was never connected, without writing', async () => {
    const db = new FakeDb();
    expect(await acquire(db)).toEqual({ kind: 'ausente' });
    expect(db.opLog.filter((o) => o.op !== 'get')).toEqual([]);
  });

  it('answers `ausente` when the stored document has no spendable refresh token', async () => {
    // Only a new consent can fix this — there is nothing to send Shopee.
    const db = new FakeDb();
    db.seed(DOC_PATH, { ...credencial(-1), refresh_token: '' });
    expect(await acquire(db)).toEqual({ kind: 'ausente' });
    expect(db.read(DOC_PATH)).not.toHaveProperty('refreshLeaseOwner');
  });

  it('answers `fresh` and writes NOTHING when the token outlives the skew', async () => {
    const db = new FakeDb();
    db.seed(DOC_PATH, credencial(REFRESH_SKEW_MS + 1));
    expect(await acquire(db)).toEqual({ kind: 'fresh', accessToken: 'at-1' });
    expect(db.opLog.filter((o) => o.op !== 'get')).toEqual([]);
  });

  it('NEAR MISS — exactly the skew is not fresh enough, and neither is a millisecond less', async () => {
    // The comparison is `expiraEm - now > skew`, strictly. `>=` here would hand
    // a caller a token that lapses inside the round trip it is about to make.
    for (const restante of [REFRESH_SKEW_MS, REFRESH_SKEW_MS - 1]) {
      const db = new FakeDb();
      db.seed(DOC_PATH, credencial(restante));
      expect(await acquire(db)).toEqual({ kind: 'acquired', refreshToken: 'rt-1' });
    }
  });

  it('acquires the lease and stamps owner + expiry on the document', async () => {
    const db = new FakeDb();
    db.seed(DOC_PATH, credencial(-1));
    expect(await acquire(db)).toEqual({ kind: 'acquired', refreshToken: 'rt-1' });
    expect(db.read(DOC_PATH)).toMatchObject({
      refreshLeaseOwner: 'owner-a',
      refreshLeaseExpiraEm: T0 + REFRESH_LEASE_TTL_MS,
    });
  });

  it('answers `held` while someone else holds a live lease, without writing', async () => {
    const db = new FakeDb();
    db.seed(
      DOC_PATH,
      credencial(-1, { refreshLeaseOwner: 'owner-b', refreshLeaseExpiraEm: T0 + 1 }),
    );
    expect(await acquire(db)).toEqual({ kind: 'held', leaseExpiraEm: T0 + 1 });
    expect(db.read(DOC_PATH)).toMatchObject({ refreshLeaseOwner: 'owner-b' });
  });

  it('NEAR MISS — `now === expiraEm` is expired and takeable; one ms earlier is held', async () => {
    const takeable = new FakeDb();
    takeable.seed(
      DOC_PATH,
      credencial(-1, { refreshLeaseOwner: 'owner-b', refreshLeaseExpiraEm: T0 }),
    );
    expect(await acquire(takeable)).toEqual({ kind: 'acquired', refreshToken: 'rt-1' });

    const held = new FakeDb();
    held.seed(
      DOC_PATH,
      credencial(-1, { refreshLeaseOwner: 'owner-b', refreshLeaseExpiraEm: T0 + 1 }),
    );
    expect(await acquire(held)).toMatchObject({ kind: 'held' });
  });

  it('treats OUR OWN owner id as re-entrant recovery, never as `held`', async () => {
    // An OCC retry re-runs the callback against a document our own earlier
    // attempt may already have stamped. Reading that as `held` would deadlock a
    // caller against itself for the whole TTL.
    const db = new FakeDb();
    db.seed(
      DOC_PATH,
      credencial(-1, { refreshLeaseOwner: 'owner-a', refreshLeaseExpiraEm: T0 + 10_000 }),
    );
    expect(await acquire(db, 'owner-a')).toEqual({ kind: 'acquired', refreshToken: 'rt-1' });
  });

  it.each([
    ['a string expiry', { refreshLeaseOwner: 'owner-b', refreshLeaseExpiraEm: '1700000030000' }],
    ['a NaN expiry', { refreshLeaseOwner: 'owner-b', refreshLeaseExpiraEm: Number.NaN }],
    ['a numeric owner', { refreshLeaseOwner: 7, refreshLeaseExpiraEm: T0 + 10_000 }],
    ['a missing expiry', { refreshLeaseOwner: 'owner-b' }],
  ])('NEAR MISS — a corrupt lease (%s) is takeable, never a freeze', async (_nome, lease) => {
    // ADR 0011's wrong-way default: a hand-edited or half-written document must
    // not be able to stop an account refreshing for ever.
    const db = new FakeDb();
    db.seed(DOC_PATH, credencial(-1, lease));
    expect(await acquire(db)).toEqual({ kind: 'acquired', refreshToken: 'rt-1' });
  });
});

/* -------------------------------------------------------------------------- */
/*                           Transaction 2 — commit                           */
/* -------------------------------------------------------------------------- */

describe('commit — persisting the pair (class C)', () => {
  async function commit(
    db: FakeDb,
    gasto = 'rt-1',
    owner = 'owner-a',
    pair = PAR_NOVO,
  ): Promise<CommitOutcome> {
    return novoStore(db).commit(owner, gasto, pair, T0);
  }

  it('writes the pair and clears OUR lease', async () => {
    const db = new FakeDb();
    db.seed(
      DOC_PATH,
      credencial(-1, {
        refreshLeaseOwner: 'owner-a',
        refreshLeaseExpiraEm: T0 + REFRESH_LEASE_TTL_MS,
        ultimaFalhaRefresh: { em: T0 - 1, codigo: 'error_server', terminal: true },
      }),
    );

    expect(await commit(db)).toEqual({ kind: 'committed', accessToken: 'at-2' });
    const doc = db.read(DOC_PATH);
    expect(doc).toMatchObject({
      access_token: 'at-2',
      refresh_token: 'rt-2',
      // ms in, ms out — the seconds→ms conversion happened once, in the package.
      expirationDate: PAR_NOVO.expiresAtMs - EXPIRY_GUARD_MS,
      obtidoEm: T0,
      ultimoRefreshEm: T0,
    });
    // ⚠️ PRESENT and null, never absent: `parseMergePatch` drops
    // undefined-valued keys, so an omitted key would leave the lease standing.
    expect(doc).toHaveProperty('refreshLeaseOwner');
    expect(doc?.refreshLeaseOwner).toBeNull();
    expect(doc?.refreshLeaseExpiraEm).toBeNull();
    // A success clears the stamp the panel renders.
    expect(doc?.ultimaFalhaRefresh).toBeNull();
  });

  it('keeps the fields the refresh response does not echo (update, never set)', async () => {
    // Shopee's refresh answer carries no `shop_id_list` / `merchant_id_list`, so
    // a full-document write would silently wipe them.
    const db = new FakeDb();
    db.seed(DOC_PATH, credencial(-1, { shop_id_list: [SHOP_ID], main_account_id: null }));
    await commit(db);
    expect(db.read(DOC_PATH)).toMatchObject({ shop_id_list: [SHOP_ID], shop_id: SHOP_ID });
  });

  it('answers `ausente` rather than resurrecting a credential deleted mid-refresh', async () => {
    const db = new FakeDb();
    expect(await commit(db)).toEqual({ kind: 'ausente' });
    expect(db.read(DOC_PATH)).toBeUndefined();
  });

  it('DROPS our pair when the stored refresh token is no longer the one we spent', async () => {
    // Another instance (or a re-consent) landed while we were at Shopee. Its
    // pair is the live one; ours is stale the moment it was minted.
    const db = new FakeDb();
    db.seed(DOC_PATH, {
      ...credencial(REFRESH_SKEW_MS * 10),
      access_token: 'at-3',
      refresh_token: 'rt-3',
      refreshLeaseOwner: 'owner-b',
      refreshLeaseExpiraEm: T0 + REFRESH_LEASE_TTL_MS,
    });

    expect(await commit(db)).toEqual({ kind: 'descartado', accessToken: 'at-3' });
    expect(db.read(DOC_PATH)).toMatchObject({ access_token: 'at-3', refresh_token: 'rt-3' });
    // The lease is NOT ours any more, so it is not ours to release either.
    expect(db.read(DOC_PATH)).toMatchObject({ refreshLeaseOwner: 'owner-b' });
  });

  it('logs the drop ONCE, with ids and clocks and neither token', async () => {
    const db = new FakeDb();
    db.seed(DOC_PATH, { ...credencial(1), access_token: 'at-3', refresh_token: 'rt-3' });
    await commit(db);

    expect(spyWarn).toHaveBeenCalledTimes(1);
    const serializado = JSON.stringify(spyWarn.mock.calls);
    expect(serializado).toContain(INTEGRACAO_ID);
    // #1015 — not the token, and not a prefix or a suffix of one.
    for (const proibido of ['at-1', 'at-2', 'at-3', 'rt-1', 'rt-2', 'rt-3']) {
      expect(serializado).not.toContain(proibido);
    }
  });

  it('NEAR MISS — the guard is an exact identity: a trailing space is a DIFFERENT token', async () => {
    // The stored refresh token is an identity, not a value. Normalising it here
    // would let a refresh overwrite a pair it was not derived from.
    const comEspaco = new FakeDb();
    comEspaco.seed(DOC_PATH, { ...credencial(-1), refresh_token: 'rt-1 ' });
    expect(await commit(comEspaco, 'rt-1')).toMatchObject({ kind: 'descartado' });

    const igual = new FakeDb();
    igual.seed(DOC_PATH, { ...credencial(-1), refresh_token: 'rt-1' });
    expect(await commit(igual, 'rt-1')).toMatchObject({ kind: 'committed' });
  });

  it('leaves an EXPIRED lease taken over by someone else alone, and still commits', async () => {
    // Our lease lapsed and another instance re-took it, but it has not written:
    // the stored refresh token is still the one we spent, so OUR pair is live.
    const db = new FakeDb();
    db.seed(
      DOC_PATH,
      credencial(-1, { refreshLeaseOwner: 'owner-b', refreshLeaseExpiraEm: T0 + 5_000 }),
    );
    expect(await commit(db)).toEqual({ kind: 'committed', accessToken: 'at-2' });
    expect(db.read(DOC_PATH)).toMatchObject({
      access_token: 'at-2',
      refreshLeaseOwner: 'owner-b',
    });
  });

  it('refuses a pair Shopee returned without a refresh token, BEFORE opening a transaction', async () => {
    const db = new FakeDb();
    db.seed(DOC_PATH, credencial(-1, { refreshLeaseOwner: 'owner-a', refreshLeaseExpiraEm: T0 }));

    await expect(
      commit(db, 'rt-1', 'owner-a', { ...PAR_NOVO, refreshToken: '' }),
    ).rejects.toThrow();
    // Nothing was read and nothing was written: the patch build failed first, so
    // the release path still finds the lease exactly as it left it.
    expect(db.opLog).toEqual([]);
    expect(db.read(DOC_PATH)).toMatchObject({ access_token: 'at-1' });
  });
});

/* -------------------------------------------------------------------------- */
/*                       Transaction 3 — releaseOrAdopt                       */
/* -------------------------------------------------------------------------- */

describe('releaseOrAdopt — handing the lease back (class C)', () => {
  const TERMINAL: FalhaRefresh = { codigo: 'refresh_token_expired', terminal: true };
  const TRANSITORIA: FalhaRefresh = { codigo: 'error_rate_limit', terminal: false };

  async function release(
    db: FakeDb,
    falha: FalhaRefresh | null,
    owner = 'owner-a',
    gasto = 'rt-1',
  ): Promise<ReleaseOutcome> {
    return novoStore(db).releaseOrAdopt(owner, gasto, T0, falha);
  }

  function comNossaLease(): Doc {
    return credencial(-1, {
      refreshLeaseOwner: 'owner-a',
      refreshLeaseExpiraEm: T0 + REFRESH_LEASE_TTL_MS,
    });
  }

  it('answers `ausente` when the credential is gone', async () => {
    expect(await release(new FakeDb(), TERMINAL)).toEqual({ kind: 'ausente' });
  });

  it('clears our lease and STAMPS a terminal failure', async () => {
    const db = new FakeDb();
    db.seed(DOC_PATH, comNossaLease());

    expect(await release(db, TERMINAL)).toEqual({ kind: 'liberado' });
    const doc = db.read(DOC_PATH);
    expect(doc?.refreshLeaseOwner).toBeNull();
    expect(doc?.ultimaFalhaRefresh).toEqual({
      em: T0,
      codigo: 'refresh_token_expired',
      terminal: true,
    });
  });

  it.each([
    ['a transient failure', TRANSITORIA],
    ['an unclassifiable failure', null],
  ])('clears our lease and stamps NOTHING for %s', async (_nome, falha) => {
    // A stamp drives red copy on the panel. A rate limit or a hiccup must not
    // make it flap.
    const db = new FakeDb();
    db.seed(DOC_PATH, comNossaLease());

    expect(await release(db, falha)).toEqual({ kind: 'liberado' });
    const doc = db.read(DOC_PATH);
    expect(doc?.refreshLeaseOwner).toBeNull();
    expect(doc).not.toHaveProperty('ultimaFalhaRefresh');
  });

  it('ADOPTS a newer pair BEFORE the terminal verdict is ever considered', async () => {
    // ⚠️ The ordering IS the guard. A reauth code answered against a refresh
    // token that has since been replaced says nothing about the pair now on
    // disk, and stamping it would disconnect a conta that is in fact healthy.
    const db = new FakeDb();
    db.seed(DOC_PATH, {
      ...comNossaLease(),
      access_token: 'at-3',
      refresh_token: 'rt-3',
      expirationDate: T0 + REFRESH_SKEW_MS * 10,
    });

    expect(await release(db, TERMINAL)).toEqual({ kind: 'adotado', accessToken: 'at-3' });
    const doc = db.read(DOC_PATH);
    expect(doc).not.toHaveProperty('ultimaFalhaRefresh');
    // Ours to release, so it is released.
    expect(doc?.refreshLeaseOwner).toBeNull();
  });

  it('releases without a write when the lease is not (or no longer) ours', async () => {
    const db = new FakeDb();
    db.seed(
      DOC_PATH,
      credencial(-1, { refreshLeaseOwner: 'owner-b', refreshLeaseExpiraEm: T0 + 5_000 }),
    );

    expect(await release(db, TERMINAL)).toEqual({ kind: 'liberado' });
    expect(db.opLog.filter((o) => o.op !== 'get')).toEqual([]);
    expect(db.read(DOC_PATH)).toMatchObject({ refreshLeaseOwner: 'owner-b' });
  });
});

/* -------------------------------------------------------------------------- */
/*                    getOrRefreshAccessToken — the flow                      */
/* -------------------------------------------------------------------------- */

describe('getOrRefreshAccessToken — over the real store', () => {
  /** A refresh stub that counts, so "at most one call" is checked everywhere. */
  function provedor(impl?: () => Promise<ShopeeTokenPair>) {
    return vi.fn(async () => (impl ? impl() : PAR_NOVO));
  }

  function correr(
    db: FakeDb,
    refresh: ReturnType<typeof provedor>,
    owner = 'owner-a',
    now = () => T0,
  ): Promise<string> {
    return getOrRefreshAccessToken(
      { store: novoStore(db), config: CONFIG, subject: SUBJECT, integracaoId: INTEGRACAO_ID },
      { now, refresh, newLeaseOwner: () => owner, sleep: async () => {} },
    );
  }

  it('fast path — returns the stored token with no transaction and no provider call', async () => {
    const db = new FakeDb();
    db.seed(DOC_PATH, credencial(REFRESH_SKEW_MS + 1));
    const refresh = provedor();

    await expect(correr(db, refresh)).resolves.toBe('at-1');
    expect(refresh).not.toHaveBeenCalled();
    // Exactly one read: the fast path's own `load`. No transaction opened.
    expect(db.opLog).toEqual([{ op: 'get', path: DOC_PATH }]);
  });

  it('NEAR MISS — one millisecond less than the skew and it refreshes instead', async () => {
    const db = new FakeDb();
    db.seed(DOC_PATH, credencial(REFRESH_SKEW_MS));
    const refresh = provedor();

    await expect(correr(db, refresh)).resolves.toBe('at-2');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('stores the pair BEFORE the token is observable, in one provider call', async () => {
    const db = new FakeDb();
    db.seed(DOC_PATH, credencial(-1));
    // Snapshot of what was stored at the moment Shopee answered — the document
    // must still hold the OLD pair here, and the NEW one by the time the caller
    // gets its token.
    let duranteAChamada: Doc | undefined;
    const refresh = provedor(async () => {
      duranteAChamada = { ...db.read(DOC_PATH) };
      return PAR_NOVO;
    });

    const token = await correr(db, refresh);

    expect(duranteAChamada).toMatchObject({ access_token: 'at-1', refreshLeaseOwner: 'owner-a' });
    expect(db.read(DOC_PATH)).toMatchObject({ access_token: 'at-2', refresh_token: 'rt-2' });
    expect(token).toBe('at-2');
    expect(refresh).toHaveBeenCalledTimes(1);
    // load → acquire(get, update) → commit(get, update). The pair is written by
    // the LAST op, before the token is returned.
    expect(db.opLog.map((o) => o.op)).toEqual(['get', 'get', 'update', 'get', 'update']);
    expect(refresh).toHaveBeenCalledWith(CONFIG, 'rt-1', SUBJECT);
  });

  it('refuses a conta with no credential at all', async () => {
    const db = new FakeDb();
    const refresh = provedor();
    await expect(correr(db, refresh)).rejects.toBeInstanceOf(ShopeeSemCredencialError);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('takes over an EXPIRED lease and refreshes once', async () => {
    const db = new FakeDb();
    db.seed(
      DOC_PATH,
      credencial(-1, { refreshLeaseOwner: 'owner-morto', refreshLeaseExpiraEm: T0 - 1 }),
    );
    const refresh = provedor();

    await expect(correr(db, refresh)).resolves.toBe('at-2');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(db.read(DOC_PATH)?.refreshLeaseOwner).toBeNull();
  });

  it('returns the WINNER’s token when our pair is dropped by the commit guard', async () => {
    const db = new FakeDb();
    db.seed(DOC_PATH, credencial(-1));
    const refresh = provedor(async () => {
      // Another instance commits its own pair while we are at Shopee.
      db.seed(DOC_PATH, {
        ...credencial(REFRESH_SKEW_MS * 10),
        access_token: 'at-3',
        refresh_token: 'rt-3',
      });
      return PAR_NOVO;
    });

    await expect(correr(db, refresh)).resolves.toBe('at-3');
    expect(db.read(DOC_PATH)).toMatchObject({ access_token: 'at-3', refresh_token: 'rt-3' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('stamps a terminal failure, clears the lease and rethrows the SAME instance', async () => {
    const db = new FakeDb();
    db.seed(DOC_PATH, credencial(-1));
    const morto = new ShopeeReauthRequiredError('autorização encerrada', {
      code: 'refresh_token_expired',
      kind: 'reauth',
      httpStatus: 200,
      path: '/api/v2/auth/access_token/get',
    });
    const refresh = provedor(async () => {
      throw morto;
    });

    // `toBe`, not `toBeInstanceOf`: wrapping would cost the caller the request
    // id and Shopee's own message.
    await expect(correr(db, refresh)).rejects.toBe(morto);
    const doc = db.read(DOC_PATH);
    expect(doc?.refreshLeaseOwner).toBeNull();
    expect(doc?.ultimaFalhaRefresh).toEqual({
      em: T0,
      codigo: 'refresh_token_expired',
      terminal: true,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'a rate limit',
      new ShopeeRateLimitError('devagar', {
        code: 'error_rate_limit',
        kind: 'burst',
        httpStatus: 200,
        path: '/api/v2/auth/access_token/get',
      }),
    ],
    [
      'a plain API failure',
      new ShopeeApiError('falhou', {
        code: 'error_server',
        kind: 'transient',
        httpStatus: 200,
        path: '/api/v2/auth/access_token/get',
      }),
    ],
    ['a network failure', new ShopeeNetworkError('sem rede')],
  ])('releases without a stamp for %s (the panel must not flap)', async (_nome, erro) => {
    const db = new FakeDb();
    db.seed(DOC_PATH, credencial(-1));
    const refresh = provedor(async () => {
      throw erro;
    });

    await expect(correr(db, refresh)).rejects.toBe(erro);
    const doc = db.read(DOC_PATH);
    expect(doc?.refreshLeaseOwner).toBeNull();
    expect(doc).not.toHaveProperty('ultimaFalhaRefresh');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('ADOPTS the newer pair when a reauth code races a fresh consent', async () => {
    // The most expensive wrong answer in the whole design: disconnecting a conta
    // an operator has just reconnected.
    const db = new FakeDb();
    db.seed(DOC_PATH, credencial(-1));
    const morto = new ShopeeReauthRequiredError('token de renovação expirado', {
      code: 'refresh_token_expired',
      kind: 'reauth',
      httpStatus: 200,
      path: '/api/v2/auth/access_token/get',
    });
    const refresh = provedor(async () => {
      db.seed(DOC_PATH, {
        ...credencial(REFRESH_SKEW_MS * 10),
        access_token: 'at-3',
        refresh_token: 'rt-3',
        refreshLeaseOwner: 'owner-a',
        refreshLeaseExpiraEm: T0 + REFRESH_LEASE_TTL_MS,
      });
      throw morto;
    });

    await expect(correr(db, refresh)).resolves.toBe('at-3');
    expect(db.read(DOC_PATH)).not.toHaveProperty('ultimaFalhaRefresh');
  });

  it('turns a pair that fails the credential schema into ShopeeCredencialInvalidaError', async () => {
    const db = new FakeDb();
    db.seed(DOC_PATH, credencial(-1));
    const refresh = provedor(async () => ({ ...PAR_NOVO, refreshToken: '' }));

    await expect(correr(db, refresh)).rejects.toBeInstanceOf(ShopeeCredencialInvalidaError);
    const doc = db.read(DOC_PATH);
    // The lease came back, and NOT ONE token field was touched.
    expect(doc?.refreshLeaseOwner).toBeNull();
    expect(doc).toMatchObject({ access_token: 'at-1', refresh_token: 'rt-1' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a later success clears the stamp a terminal failure left behind', async () => {
    const db = new FakeDb();
    db.seed(
      DOC_PATH,
      credencial(-1, { ultimaFalhaRefresh: { em: T0 - 1, codigo: 'shop_banned', terminal: true } }),
    );

    await expect(correr(db, provedor())).resolves.toBe('at-2');
    expect(db.read(DOC_PATH)?.ultimaFalhaRefresh).toBeNull();
  });

  it('a fresh CONSENT clears the same stamp, through credentialFromTokenPair', async () => {
    // The other writer of this document. Both paths have to clear it, or the
    // panel keeps telling the operator to reconnect an account they just did.
    const doc = credentialFromTokenPair(PAR_NOVO, { kind: 'shop', shopId: SHOP_ID }, T0);
    expect(doc.ultimaFalhaRefresh).toBeNull();
    expect(doc.refreshLeaseOwner).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                        Two callers, one refresh token                      */
/* -------------------------------------------------------------------------- */

describe('two concurrent callers', () => {
  it('spend the refresh token ONCE, abort exactly once, and agree on the token', async () => {
    // ⚠️ The two mechanisms in one test. A and B both read version N, so OCC
    // arbitrates: one commits its lease, the other ABORTS, re-runs its callback
    // against the winner's document and re-decides from THAT snapshot. Nothing
    // captured before the callback is replayed.
    const db = new FakeDb();
    db.seed(DOC_PATH, credencial(-1));

    const chegouEmA = deferred();
    const liberarA = deferred();
    let segurou = false;
    db.occ.beforeCommit = async (ctx) => {
      // Identify a run from what it is about to WRITE, never from its label.
      const escreveA = ctx.writes.some((w) => w.data.refreshLeaseOwner === 'owner-a');
      if (escreveA && !segurou) {
        segurou = true;
        chegouEmA.resolve();
        await liberarA.promise;
      }
    };

    const refresh = vi.fn(async () => PAR_NOVO);
    const correr = (owner: string): Promise<string> =>
      getOrRefreshAccessToken(
        { store: novoStore(db), config: CONFIG, subject: SUBJECT, integracaoId: INTEGRACAO_ID },
        { now: () => T0, refresh, newLeaseOwner: () => owner, sleep: async () => {} },
      );

    const promessaA = correr('owner-a');
    // A is parked with its lease write staged, having read version N.
    await chegouEmA.promise;
    const tokenB = await correr('owner-b');
    liberarA.resolve();
    const tokenA = await promessaA;

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(tokenA).toBe('at-2');
    expect(tokenB).toBe('at-2');
    expect(db.occ.txLog.filter((e) => e.phase === 'abort')).toHaveLength(1);
    // A came back through the `fresh` arm of its retried callback, so it never
    // held the lease and never wrote.
    expect(db.read(DOC_PATH)).toMatchObject({ access_token: 'at-2', refresh_token: 'rt-2' });
    expect(db.read(DOC_PATH)?.refreshLeaseOwner).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                   The poll loop, over an in-memory port                    */
/* -------------------------------------------------------------------------- */

describe('getOrRefreshAccessToken — waiting on someone else’s lease', () => {
  /** A scripted port double: no Firestore, no engine, just the outcomes. */
  function portaDupla() {
    return {
      load: vi.fn<ShopeeLeasedTokenStore['load']>(),
      acquire: vi.fn<ShopeeLeasedTokenStore['acquire']>(),
      commit: vi.fn<ShopeeLeasedTokenStore['commit']>(),
      releaseOrAdopt: vi.fn<ShopeeLeasedTokenStore['releaseOrAdopt']>(),
    };
  }

  /** Advances the clock instead of waiting, so the budget is spent for real. */
  function relogio() {
    let agora = T0;
    return {
      now: () => agora,
      sleep: async (ms: number) => {
        agora += ms;
      },
    };
  }

  /** The provider seam, typed as `getOrRefreshAccessToken` takes it. */
  function refreshFalso(impl?: () => Promise<ShopeeTokenPair>) {
    return vi.fn(
      async (_config: ShopeeOAuthConfig, _refreshToken: string, _subject: ShopeeRefreshSubject) =>
        impl ? impl() : PAR_NOVO,
    );
  }

  function correr(store: ReturnType<typeof portaDupla>, refresh: ReturnType<typeof refreshFalso>) {
    const { now, sleep } = relogio();
    return getOrRefreshAccessToken(
      {
        store: store as unknown as ShopeeLeasedTokenStore,
        config: CONFIG,
        subject: SUBJECT,
        integracaoId: INTEGRACAO_ID,
      },
      { now, sleep, refresh, newLeaseOwner: () => 'owner-a' },
    );
  }

  it('returns the winner’s token mid-poll, with ZERO provider calls', async () => {
    const store = portaDupla();
    store.load
      .mockResolvedValueOnce(credencial(-1) as never)
      .mockResolvedValueOnce(
        credencial(-1, {
          refreshLeaseOwner: 'owner-b',
          refreshLeaseExpiraEm: T0 + 20_000,
        }) as never,
      )
      .mockResolvedValue(credencial(REFRESH_SKEW_MS * 10) as never);
    store.acquire.mockResolvedValue({ kind: 'held', leaseExpiraEm: T0 + 20_000 });
    const refresh = refreshFalso();

    await expect(correr(store, refresh)).resolves.toBe('at-1');
    expect(refresh).not.toHaveBeenCalled();
    // One claim attempt only: the loop ended because a token appeared, not
    // because the lease did.
    expect(store.acquire).toHaveBeenCalledTimes(1);
    expect(store.commit).not.toHaveBeenCalled();
  });

  it('stops polling as soon as the holder RELEASES, then claims', async () => {
    const store = portaDupla();
    store.load
      .mockResolvedValueOnce(credencial(-1) as never)
      // Still expired, but the lease is gone — the holder failed or crashed.
      .mockResolvedValue(credencial(-1) as never);
    store.acquire
      .mockResolvedValueOnce({ kind: 'held', leaseExpiraEm: T0 + 20_000 })
      .mockResolvedValueOnce({ kind: 'acquired', refreshToken: 'rt-1' });
    store.commit.mockResolvedValue({ kind: 'committed', accessToken: 'at-2' });
    const refresh = refreshFalso();

    await expect(correr(store, refresh)).resolves.toBe('at-2');
    expect(refresh).toHaveBeenCalledTimes(1);
    // Two loads: the fast path and one poll iteration. It did not wait out the
    // budget for a lease nobody was holding.
    expect(store.load).toHaveBeenCalledTimes(2);
  });

  it('gives up with a TRANSIENT error when the lease is held for the whole budget', async () => {
    const store = portaDupla();
    const preso = credencial(-1, {
      refreshLeaseOwner: 'owner-b',
      refreshLeaseExpiraEm: T0 + 60_000,
    });
    store.load.mockResolvedValue(preso as never);
    store.acquire.mockResolvedValue({ kind: 'held', leaseExpiraEm: T0 + 60_000 });
    const refresh = refreshFalso();

    await expect(correr(store, refresh)).rejects.toBeInstanceOf(ShopeeRefreshEmAndamentoError);
    expect(refresh).not.toHaveBeenCalled();
    // ⚠️ The budget is spent, never exceeded: `load` runs once for the fast path
    // plus at most one iteration per poll interval.
    const maximo = 1 + Math.ceil(REFRESH_POLL_BUDGET_MS / REFRESH_POLL_INTERVAL_MS);
    expect(store.load.mock.calls.length).toBeLessThanOrEqual(maximo);
    // Exactly two claim attempts: the first, and the one after the budget.
    expect(store.acquire).toHaveBeenCalledTimes(2);
    expect(store.commit).not.toHaveBeenCalled();
    expect(store.releaseOrAdopt).not.toHaveBeenCalled();
  });

  it('carries the holder’s lease expiry so the caller can be told when to retry', async () => {
    const store = portaDupla();
    store.load.mockResolvedValue(
      credencial(-1, { refreshLeaseOwner: 'owner-b', refreshLeaseExpiraEm: T0 + 60_000 }) as never,
    );
    store.acquire.mockResolvedValue({ kind: 'held', leaseExpiraEm: T0 + 60_000 });

    await expect(correr(store, refreshFalso())).rejects.toMatchObject({
      leaseExpiraEm: T0 + 60_000,
    });
  });

  it('refuses when the conta is disconnected mid-poll', async () => {
    const store = portaDupla();
    store.load.mockResolvedValueOnce(credencial(-1) as never).mockResolvedValue(null);
    store.acquire.mockResolvedValue({ kind: 'held', leaseExpiraEm: T0 + 60_000 });

    await expect(correr(store, refreshFalso())).rejects.toBeInstanceOf(ShopeeSemCredencialError);
  });
});
