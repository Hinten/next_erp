/**
 * The leased refresh (`./tokenStore.ts`) against a REAL Firestore — the emulator
 * lane, `ci-shopee.yml`'s ONE job (`vitest.tasks.config.ts` collects the
 * `.firestore.` suffix since step 22, #1530: the Loja Integrada fold).
 *
 * `tokenStore.test.ts` covers the same three transactions over a `FakeDb` wired
 * to the shared `OccEngine`. That is a good test of the LOGIC, but the double is
 * the test telling itself what the store looked like — so this file covers
 * exactly what only the real engine can show, and nothing else:
 *
 *  1. **Two callers past the fast path at once spend the refresh token ONCE**,
 *     arbitrated by the emulator's own transactions rather than a staged abort.
 *     ⚠️ OUTCOMES only — never an abort count or a lock wait. The emulator's
 *     transactions are documented to differ from production's (its locks "may
 *     take up to 30 seconds"), so an assertion about HOW it arbitrated would be
 *     an assertion about the emulator.
 *  2. **`tx.update` on a nested map REPLACES it.** A top-level
 *     `ultimaFalhaRefresh` key must replace the stored map, never deep-merge into
 *     it. `FakeDb`'s `set` ignores `merge`, so the in-memory suite stays GREEN
 *     under a `set(…, { merge: true })` mutant; only this file reds it.
 *  3. **Engine-shaped corrupt leases.** Only the Admin SDK's read path hands
 *     back a `Timestamp` instance — what a hand edit in the Firebase console
 *     produces. The double holds whatever object a test put in it.
 *  4. **The `default` database wiring**, through the PRODUCTION accessor
 *     `getAdminFirestore()`: it honours `FIREBASE_DATABASE_ID`, and a document
 *     lands on the `default` database. In the emulator a mis-targeted
 *     `(default)` database silently exists and auto-creates
 *     (`vitest.tasks.setup.ts` (3)), so every case below carries a POSITIVE
 *     existence assertion. ⚠️ The accessor's `?? 'default'` FALLBACK — what a
 *     deployed backend runs — is never reached here: the job env and setup (3)
 *     both supply the variable. `lib/firebase/admin.test.ts` pins it, offline.
 *  5. **The server `updateTime`** as the proof that no write CHANGED the
 *     document on the held, dropped and adopted paths. ⚠️ Not that no write was
 *     ISSUED: Firestore keeps the previous `update_time` for a write that changes
 *     nothing, so a no-op write is invisible to it.
 *
 * Deliberately NOT re-tested here (the in-memory suite owns them): the constants
 * invariant, the fast path, the `ausente` arms, the skew boundaries, the schema
 * refusal before the transaction, the poll loop's own counts, the log line and
 * the lapsed-and-re-taken commit branch.
 *
 * ⚠️ Shared emulators (`vitest.tasks.config.ts`'s header). This file NEVER writes
 * `integracao/{id}` — only the `credenciais/current` subcollection document, which
 * no trigger watches — so `onIntegracaoShopeeChanged` cannot fire and no sweep
 * can enumerate these contas. Every case mints its own `int-token-<uuid>` (the
 * round trips own `int-1`…`int-4`) and `afterEach` deletes what it wrote.
 *
 * ⚠️ No network. Every case injects the provider call (`refresh`), and runs
 * wholly in THIS process, where `vitest.tasks.setup.ts` (4)'s kill-switch
 * covers `fetch`: a case that forgot to inject would reach the real
 * `refreshAccessToken` and fail there, never leave the runner. Token values are
 * obviously fake (`at-1`, `rt-1`, shop 220099).
 */
import { randomUUID } from 'node:crypto';
import { type DocumentSnapshot, type Firestore, Timestamp } from 'firebase-admin/firestore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { credenciaisIntegracaoCollection } from '@delfrance/data/admin/collections';
import {
  type ShopeeAuthSubject,
  ShopeeNetworkError,
  type ShopeeOAuthConfig,
  ShopeeReauthRequiredError,
  type ShopeeRefreshSubject,
  type ShopeeTokenPair,
  resolveShopeeHosts,
} from '@delfrance/integrations-shopee';

import { getAdminFirestore } from '@/lib/firebase/admin';

import {
  SHOPEE_CREDENCIAL_DOC_ID,
  createShopeeCredentialStore,
  credentialFromTokenPair,
} from './credentialStore';
import {
  type AcquireOutcome,
  REFRESH_LEASE_TTL_MS,
  REFRESH_SKEW_MS,
  ShopeeRefreshEmAndamentoError,
  type ShopeeLeasedTokenStore,
  createShopeeTokenStore,
  getOrRefreshAccessToken,
} from './tokenStore';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

/* -------------------------------------------------------------------------- */
/*                                  Fixtures                                  */
/* -------------------------------------------------------------------------- */

/** An arbitrary but fixed instant, so every clock arithmetic below is readable. */
const T0 = 1_700_000_000_000;

const SHOP_ID = 220099;
/** Who the refresh is keyed on… */
const SUBJECT: ShopeeRefreshSubject = { kind: 'shop', shopId: SHOP_ID };
/** …and who consented: the same shop, in the consent writer's own type. */
const CONSENTIDO: ShopeeAuthSubject = { kind: 'shop', shopId: SHOP_ID };

/** Never used for a call — every case injects `refresh`. */
const CONFIG: ShopeeOAuthConfig = {
  partnerId: 1234567,
  partnerKey: 'chave-de-teste',
  hosts: resolveShopeeHosts({ sandbox: true }),
};

/**
 * The pair a consent stored. `expirationDate` lands at T0 + 5 s, well under the
 * 60 s skew, so every case at T0 takes the refresh path.
 */
const PAR_INICIAL: ShopeeTokenPair = {
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAtMs: T0 + 10_000,
  requestId: 'req-1',
  shopIdList: [SHOP_ID],
  merchantIdList: null,
};

/** The pair Shopee answers a refresh with. */
const PAR_NOVO: ShopeeTokenPair = {
  accessToken: 'at-2',
  refreshToken: 'rt-2',
  expiresAtMs: T0 + 4 * 60 * 60 * 1000,
  requestId: 'req-2',
  shopIdList: null,
  merchantIdList: null,
};

/** The pair an operator's re-consent writes while a refresh is in flight. */
const PAR_CONSENT: ShopeeTokenPair = {
  accessToken: 'at-consent',
  refreshToken: 'rt-consent',
  expiresAtMs: T0 + 4 * 60 * 60 * 1000,
  requestId: 'req-consent',
  shopIdList: [SHOP_ID],
  merchantIdList: null,
};

/** A dead grant, as the package raises it for the refresh endpoint. */
function grantMorto(): ShopeeReauthRequiredError {
  return new ShopeeReauthRequiredError('token de renovação expirado', {
    code: 'refresh_token_expired',
    kind: 'reauth',
    httpStatus: 200,
    path: '/api/v2/auth/access_token/get',
  });
}

/* -------------------------------------------------------------------------- */
/*                                  Harness                                   */
/* -------------------------------------------------------------------------- */

/**
 * Resolved per call, never at import: without the emulator this file must SKIP,
 * and `getAdminFirestore()` throws when no project id is configured.
 */
const db = (): Firestore => getAdminFirestore();

/** Every conta id this file wrote under, so `afterEach` can delete it. */
const criados = new Set<string>();

/** A fresh, never-before-used conta id — the round trips own `int-1`…`int-4`. */
function novaConta(): string {
  const id = `int-token-${randomUUID()}`;
  criados.add(id);
  return id;
}

function refDe(integracaoId: string) {
  return credenciaisIntegracaoCollection.docRef(db(), { integracaoId }, SHOPEE_CREDENCIAL_DOC_ID);
}

/** The PHYSICAL document, unparsed — what the store actually wrote. */
async function lerCru(integracaoId: string): Promise<DocumentSnapshot> {
  return refDe(integracaoId).get();
}

/** The stored fields of a snapshot that must exist (the positive assertion). */
function campos(snap: DocumentSnapshot): Record<string, unknown> {
  expect(snap.exists).toBe(true);
  return snap.data() ?? {};
}

/** Seed through the PRODUCTION consent writer — the shape every conta starts from. */
async function semearConsentimento(integracaoId: string): Promise<void> {
  await createShopeeCredentialStore(db(), integracaoId).save(
    credentialFromTokenPair(PAR_INICIAL, CONSENTIDO, T0 - 1),
  );
}

/**
 * Seed RAW, around the schema — for the shapes a consent never writes (a
 * corrupt lease, a legacy stamp). The handle has no converter, so this is the
 * Admin SDK's own `set`.
 */
async function semearCru(integracaoId: string, sobre: Record<string, unknown>): Promise<void> {
  await refDe(integracaoId).set({
    ...credentialFromTokenPair(PAR_INICIAL, CONSENTIDO, T0 - 1),
    ...sobre,
  });
}

/** An injectable clock that only moves when a caller's `sleep` moves it. */
function relogio(inicio: number) {
  let agora = inicio;
  return {
    now: (): number => agora,
    avancar: (ms: number): void => {
      agora += ms;
    },
  };
}

/** The provider seam, typed as `getOrRefreshAccessToken` takes it. */
function provedor(impl: () => Promise<ShopeeTokenPair> = async () => PAR_NOVO) {
  return vi.fn(
    async (
      _config: ShopeeOAuthConfig,
      _refreshToken: string,
      _subject: ShopeeRefreshSubject,
    ): Promise<ShopeeTokenPair> => impl(),
  );
}

/**
 * One caller, with its own clock and lease owner. `sleep` ADVANCES the clock,
 * so a mutant that wrongly waits spends the poll budget in a dozen iterations
 * and reds fast instead of running into the 60 s test timeout.
 */
function chamador(
  integracaoId: string,
  opts: {
    readonly inicio: number;
    readonly owner: string;
    readonly refresh: ReturnType<typeof provedor>;
    readonly store?: ShopeeLeasedTokenStore;
    readonly antesDeDormir?: () => Promise<void>;
  },
) {
  const r = relogio(opts.inicio);
  const sleep = vi.fn(async (ms: number): Promise<void> => {
    await opts.antesDeDormir?.();
    r.avancar(ms);
  });
  const correr = (): Promise<string> =>
    getOrRefreshAccessToken(
      {
        store: opts.store ?? createShopeeTokenStore(db(), integracaoId),
        config: CONFIG,
        subject: SUBJECT,
        integracaoId,
      },
      { now: r.now, refresh: opts.refresh, sleep, newLeaseOwner: () => opts.owner },
    );
  return { correr, sleep };
}

/** A count-down: `todos` settles once `chegar()` has been called `partes` times. */
function barreira(partes: number) {
  let chegaram = 0;
  let liberar!: () => void;
  const todos = new Promise<void>((resolve) => {
    liberar = resolve;
  });
  return {
    todos,
    chegar(): void {
      chegaram += 1;
      if (chegaram === partes) liberar();
    },
  };
}

afterEach(async () => {
  await Promise.all([...criados].map((id) => refDe(id).delete()));
  criados.clear();
});

/* -------------------------------------------------------------------------- */
/*                                   Cases                                    */
/* -------------------------------------------------------------------------- */

describe.skipIf(!EMULATED)('the leased token refresh on the Firestore emulator', () => {
  it('E0: targets the `default` database through the production accessor', async () => {
    // ⚠️ Enterprise names the database `default`; `(default)` fails every op in
    // production and silently auto-creates here, so the name is asserted and
    // a document is proved to exist ON it. This proves the accessor honours
    // `FIREBASE_DATABASE_ID` — which the job env and setup (3) always set — and
    // never its `?? 'default'` fallback (`lib/firebase/admin.test.ts` owns that).
    expect(db().databaseId).toBe('default');
    const id = novaConta();
    await semearConsentimento(id);
    expect(campos(await lerCru(id))).toMatchObject({ access_token: 'at-1', refresh_token: 'rt-1' });
  });

  it('E1: two callers past the fast path at once spend the refresh token ONCE', async () => {
    const id = novaConta();
    await semearConsentimento(id);

    // Three happens-before edges, never a timer:
    //  - both callers' FIRST `load` meet, so both read the stale pair before
    //    either claims — a serialized run would send the second down the fast
    //    path and never race at all;
    //  - the provider call waits until BOTH claims have settled, so the winner
    //    cannot commit before the loser's claim has been decided;
    //  - the loser's `sleep` waits for the winner's commit, so its next poll
    //    reads the fresh pair instead of racing a wall-clock guess.
    const leram = barreira(2);
    const reivindicaram = barreira(2);
    const gravou = barreira(1);
    const desfechos: AcquireOutcome['kind'][] = [];

    /** The REAL store, with only the three edges observed. */
    function observado(): ShopeeLeasedTokenStore {
      const real = createShopeeTokenStore(db(), id);
      let primeiraLeitura = true;
      return {
        async load() {
          const lida = await real.load();
          if (primeiraLeitura) {
            primeiraLeitura = false;
            leram.chegar();
            await leram.todos;
          }
          return lida;
        },
        async acquire(...a) {
          // `finally`: a claim that THROWS must still release the provider
          // call, or the case would hang into the timeout instead of failing.
          try {
            const desfecho = await real.acquire(...a);
            desfechos.push(desfecho.kind);
            return desfecho;
          } finally {
            reivindicaram.chegar();
          }
        },
        async commit(...a) {
          try {
            return await real.commit(...a);
          } finally {
            gravou.chegar();
          }
        },
        releaseOrAdopt: (...a) => real.releaseOrAdopt(...a),
      };
    }

    const refresh = provedor(async () => {
      await reivindicaram.todos;
      return PAR_NOVO;
    });
    const a = chamador(id, {
      inicio: T0,
      owner: 'owner-a',
      refresh,
      store: observado(),
      antesDeDormir: () => gravou.todos,
    });
    const b = chamador(id, {
      inicio: T0,
      owner: 'owner-b',
      refresh,
      store: observado(),
      antesDeDormir: () => gravou.todos,
    });

    const [tokenA, tokenB] = await Promise.all([a.correr(), b.correr()]);

    // THE discriminating assertion: one claim won, the other found it HELD.
    // Serialized, it would read `['acquired']`; with no exclusion at all,
    // `['acquired', 'acquired']` and two provider calls.
    expect([...desfechos].sort()).toEqual(['acquired', 'held']);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(CONFIG, 'rt-1', SUBJECT);
    // Nobody is handed a dead token: the loser polled ONCE, onto the winner's.
    expect(tokenA).toBe('at-2');
    expect(tokenB).toBe('at-2');
    expect(a.sleep.mock.calls.length + b.sleep.mock.calls.length).toBe(1);
    // `shop_id_list` survives: the commit is an `update`, never a `set`.
    expect(campos(await lerCru(id))).toMatchObject({
      access_token: 'at-2',
      refresh_token: 'rt-2',
      refreshLeaseOwner: null,
      refreshLeaseExpiraEm: null,
      ultimoRefreshEm: T0,
      shop_id: SHOP_ID,
      shop_id_list: [SHOP_ID],
    });
  });

  it('E3a: a crashed refresher’s lease is taken over EXACTLY at its TTL, on the first claim', async () => {
    const id = novaConta();
    await semearConsentimento(id);
    // A refresher that claimed and died: its lease is on disk, never released.
    await expect(
      createShopeeTokenStore(db(), id).acquire(
        'owner-morto',
        T0,
        REFRESH_LEASE_TTL_MS,
        REFRESH_SKEW_MS,
      ),
    ).resolves.toEqual({ kind: 'acquired', refreshToken: 'rt-1' });
    // Positive: the expiry is a NUMBER that round-trips through the engine.
    expect(campos(await lerCru(id))).toMatchObject({
      refreshLeaseOwner: 'owner-morto',
      refreshLeaseExpiraEm: T0 + REFRESH_LEASE_TTL_MS,
    });

    const refresh = provedor();
    const b = chamador(id, { inicio: T0 + REFRESH_LEASE_TTL_MS, owner: 'owner-b', refresh });

    // `now === expiraEm` is EXPIRED: taken on the first claim, no poll at all.
    await expect(b.correr()).resolves.toBe('at-2');
    expect(b.sleep).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(CONFIG, 'rt-1', SUBJECT);
    expect(campos(await lerCru(id))).toMatchObject({
      refresh_token: 'rt-2',
      refreshLeaseOwner: null,
      refreshLeaseExpiraEm: null,
    });
  });

  it('E3b: NEAR MISS — one ms after the claim, the lease stays LIVE for the whole poll budget', async () => {
    const id = novaConta();
    await semearConsentimento(id);
    await createShopeeTokenStore(db(), id).acquire(
      'owner-morto',
      T0,
      REFRESH_LEASE_TTL_MS,
      REFRESH_SKEW_MS,
    );
    const antes = await lerCru(id);
    expect(campos(antes)).toMatchObject({ refreshLeaseOwner: 'owner-morto' });

    const refresh = provedor();
    const b = chamador(id, { inicio: T0 + 1, owner: 'owner-b', refresh });

    const erro = await b.correr().then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(ShopeeRefreshEmAndamentoError);
    expect(erro).toMatchObject({ leaseExpiraEm: T0 + REFRESH_LEASE_TTL_MS });
    expect(refresh).not.toHaveBeenCalled();
    expect(b.sleep).toHaveBeenCalled();
    // Nothing changed: a held claim and a poll write nothing, so the server's
    // `updateTime` has not moved and the dead refresher's lease still stands.
    const depois = await lerCru(id);
    expect(depois.updateTime?.isEqual(antes.updateTime!)).toBe(true);
    expect(campos(depois)).toMatchObject({
      refreshLeaseOwner: 'owner-morto',
      refresh_token: 'rt-1',
    });
  });

  it('E4: the commit guard DROPS our pair when a consent lands mid-refresh', async () => {
    const id = novaConta();
    await semearConsentimento(id);

    let doConsentimento: Timestamp | undefined;
    const refresh = provedor(async () => {
      // The operator re-consents while we are at Shopee: the production
      // consent writer, a full-document `set` that also clears our lease.
      await createShopeeCredentialStore(db(), id).save(
        credentialFromTokenPair(PAR_CONSENT, CONSENTIDO, T0 + 1),
      );
      doConsentimento = (await lerCru(id)).updateTime;
      return PAR_NOVO;
    });
    const b = chamador(id, { inicio: T0, owner: 'owner-b', refresh });

    // The stored token is returned, never the pair we were handed.
    await expect(b.correr()).resolves.toBe('at-consent');
    const depois = await lerCru(id);
    expect(campos(depois)).toMatchObject({
      access_token: 'at-consent',
      refresh_token: 'rt-consent',
      obtidoEm: T0 + 1,
      ultimoRefreshEm: null,
      refreshLeaseOwner: null,
      refreshLeaseExpiraEm: null,
    });
    // The losing commit writes nothing — the consent had already cleared the
    // lease, so there was not even a lease of ours to hand back. The assertion
    // shows the document is UNCHANGED since the consent, not that no write was
    // issued (header item 5).
    expect(doConsentimento).toBeDefined();
    expect(depois.updateTime?.isEqual(doConsentimento!)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('E5: the release ADOPTS the newer pair when a consent races a dead-grant answer', async () => {
    const id = novaConta();
    await semearConsentimento(id);

    let doConsentimento: Timestamp | undefined;
    const refresh = provedor(async () => {
      await createShopeeCredentialStore(db(), id).save(
        credentialFromTokenPair(PAR_CONSENT, CONSENTIDO, T0 + 1),
      );
      doConsentimento = (await lerCru(id)).updateTime;
      // A reauth code about a refresh token that has SINCE been replaced says
      // nothing about the pair now on disk.
      throw grantMorto();
    });
    const b = chamador(id, { inicio: T0, owner: 'owner-b', refresh });

    // RESOLVES: stamping the dead-grant verdict here would disconnect a conta
    // the operator has just reconnected.
    await expect(b.correr()).resolves.toBe('at-consent');
    const depois = await lerCru(id);
    // The consent's explicit null, never a stamp.
    expect(campos(depois)).toMatchObject({ refresh_token: 'rt-consent', ultimaFalhaRefresh: null });
    expect(doConsentimento).toBeDefined();
    expect(depois.updateTime?.isEqual(doConsentimento!)).toBe(true);
  });

  /** A stamp an OLDER writer left, with a key today's writer never emits. */
  const MAPA_LEGADO = { em: 1, codigo: 'antigo', terminal: true, detalhe: 'legado' };

  /** E6: one failed refresh over {@link MAPA_LEGADO}, and what the stamp must read after. */
  async function falharSobreMapaLegado(erro: Error, esperado: unknown): Promise<void> {
    const id = novaConta();
    await semearCru(id, { ultimaFalhaRefresh: MAPA_LEGADO });
    const refresh = provedor(async () => {
      throw erro;
    });
    const b = chamador(id, { inicio: T0, owner: 'owner-b', refresh });

    // The SAME instance: wrapping would cost the caller Shopee's own code.
    await expect(b.correr()).rejects.toBe(erro);
    const depois = campos(await lerCru(id));
    expect(depois.ultimaFalhaRefresh).toEqual(esperado);
    // Our lease is handed back on every exit…
    expect(depois).toMatchObject({ refreshLeaseOwner: null, refreshLeaseExpiraEm: null });
    // …and the rest of the document is untouched: an `update`, never a `set`.
    expect(depois).toMatchObject({ access_token: 'at-1', refresh_token: 'rt-1', shop_id: SHOP_ID });
  }

  it('E6-T: a TERMINAL failure REPLACES the stored stamp map wholesale', async () => {
    // `detalhe` is GONE: a top-level key on `tx.update` replaces the map. A
    // `set(…, { merge: true })` would deep-merge and keep it — and the FakeDb's
    // `set` ignores `merge`, so only this engine can tell the two apart.
    await falharSobreMapaLegado(grantMorto(), {
      em: T0,
      codigo: 'refresh_token_expired',
      terminal: true,
    });
  });

  it('E6-N: NEAR MISS — a TRANSIENT failure leaves the stored stamp alone', async () => {
    // A rate limit or a hiccup must not make the panel flap red.
    await falharSobreMapaLegado(new ShopeeNetworkError('sem rede'), MAPA_LEGADO);
  });

  /** E7: a corrupt lease on disk must read as NO lease — taken on the first claim. */
  async function tomarLeaseCorrompida(
    lease: { readonly refreshLeaseOwner: string; readonly refreshLeaseExpiraEm: unknown },
    expiraEmTimestamp: boolean,
  ): Promise<void> {
    const id = novaConta();
    await semearCru(id, lease);
    // Positive: the corruption really is on disk, in the engine's own shape —
    // the Admin SDK reads a `Timestamp` back as an INSTANCE, which only the real
    // read path can hand `leaseOf`.
    const cru = campos(await lerCru(id));
    expect(cru).toMatchObject({ refreshLeaseOwner: lease.refreshLeaseOwner });
    expect(cru.refreshLeaseExpiraEm).toEqual(lease.refreshLeaseExpiraEm);
    expect(cru.refreshLeaseExpiraEm instanceof Timestamp).toBe(expiraEmTimestamp);

    const refresh = provedor();
    const b = chamador(id, { inicio: T0, owner: 'owner-b', refresh });

    // A lease that cannot be READ can never freeze a conta (ADR 0011's wrong-way
    // default). A reader that believed it would poll and answer 503.
    await expect(b.correr()).resolves.toBe('at-2');
    expect(b.sleep).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    // `acquire` overwrote the corrupt lease with ours, and `commit` cleared it.
    expect(campos(await lerCru(id))).toMatchObject({
      refresh_token: 'rt-2',
      refreshLeaseOwner: null,
      refreshLeaseExpiraEm: null,
    });
  }

  it('E7-a: a corrupt lease with a TIMESTAMP expiry (a console edit) reads as no lease', async () => {
    // Believed, this lease would be held until 2100.
    await tomarLeaseCorrompida(
      {
        refreshLeaseOwner: 'console',
        refreshLeaseExpiraEm: Timestamp.fromMillis(Date.UTC(2100, 0, 1)),
      },
      true,
    );
  });

  it('E7-b: a corrupt lease with an EMPTY owner reads as no lease', async () => {
    await tomarLeaseCorrompida(
      { refreshLeaseOwner: '', refreshLeaseExpiraEm: T0 + 10 * REFRESH_LEASE_TTL_MS },
      false,
    );
  });
});
