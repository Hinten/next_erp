/**
 * The Shopee access-token store: one refresh at a time per conta, serialized by
 * a lease that EXPIRES, with the provider round trip outside every transaction.
 *
 * ## Why a lease at all, when nothing else in this repo has one
 *
 * ADR 0011 rejected pessimistic leases for general writes, and it is right to:
 * the balanço lock is the repo's own example of a lock that cannot expire. The
 * master plan overrides that for token refresh ONLY, and for one reason —
 * Shopee's refresh token is **single-use and rotating**, so two instances that
 * both spend it do not merely write twice, they can burn the pair. Firestore's
 * OCC alone cannot prevent that: OCC arbitrates the WRITE, and the expensive act
 * (the `POST /api/v2/auth/access_token/get`) happens between two of them.
 *
 * Everything that made the legacy Flutter `isRefreshing` flag fatal is inverted
 * here: the lease carries an EXPIRY rather than a boolean, it is **never
 * renewed** (a lock that renews itself cannot expire), a corrupt lease reads as
 * no lease at all, and every release path runs — including the one where the
 * provider call throws.
 *
 * ## What FAQ 144 buys us, and what it does not
 *
 * Shopee's API page says a refresh token "can be used once only"; Shopee's own
 * FAQ 144 says a used refresh token stays valid for four more hours and, re-sent,
 * returns the SAME new pair. The two readings disagree and the store is designed
 * for both — see the guard in `commit`, which is written to be correct under the
 * pessimistic reading and merely wasteful under the optimistic one.
 *
 * ## The three transactions
 *
 * `acquire` (class A), `commit` (class C) and `releaseOrAdopt` (class C) are
 * inventoried in `packages/config-eslint/rules/firestore-transaction-inventory.test.js`,
 * which is where the race analysis lives in full.
 *
 * ⚠️ The token is NEVER cached (`@delfrance/data/admin/cache` forbidden case #3)
 * and never logged, not even a prefix or a suffix of one (#1015,
 * `apps/shopee/CLAUDE.md` rule 4). Log lines carry the integração id, ms clocks
 * and Shopee's error CODE, and nothing else.
 */
import { randomUUID } from 'node:crypto';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { credenciaisIntegracaoCollection } from '@delfrance/data/admin/collections';
import type { CredenciaisIntegracao } from '@delfrance/schemas';
import {
  ShopeeApiError,
  ShopeeHttpError,
  ShopeeNetworkError,
  type ShopeeOAuthConfig,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  type ShopeeRefreshSubject,
  ShopeeSchemaError,
  type ShopeeTokenPair,
  refreshAccessToken,
} from '@delfrance/integrations-shopee';
import { z } from 'zod';

import {
  EXPIRY_GUARD_MS,
  SHOPEE_CREDENCIAL_DOC_ID,
  ShopeeCredencialInvalidaError,
  accessTokenOf,
  createShopeeCredentialStore,
  expiryOf,
  leaseOf,
  refreshTokenOf,
} from './credentialStore';
import { validationPaths } from './validationIssues';

/* -------------------------------------------------------------------------- */
/*                                 Constants                                  */
/* -------------------------------------------------------------------------- */

/**
 * Refresh a token with less than this much life left, never mid-flight.
 *
 * Also the width of the window the recovery below has to fit inside: the refresh
 * path is only ever entered with under a minute of token left.
 */
export const REFRESH_SKEW_MS = 60_000;

/**
 * How long a refresh lease is honoured before anyone may take it over.
 *
 * ⚠️ The invariant is `POLL_BUDGET < LEASE_TTL < SKEW`, and both inequalities
 * are load-bearing (a test pins them):
 *
 *  - **TTL below the SKEW** so a crashed or hung refresher's lease expires while
 *    the old access token is still nominally alive — the takeover lands inside
 *    the window the skew reserved, instead of after the conta has already
 *    stopped working. `shopeeCall` has no timeout, so a hung fetch is the crash
 *    case by another name and is recovered the same way.
 *  - **BUDGET below the TTL** so a caller that waited out the whole budget and
 *    tries once more is still refusing to steal a LIVE lease; it answers 503 and
 *    lets its caller retry, rather than racing the holder.
 *
 * Err LONG on the TTL. Too short lets a second instance re-spend a refresh token
 * — which under the API page's "once only" reading burns the pair; too long only
 * costs a few 503s while the conta keeps working on the token it already has.
 */
export const REFRESH_LEASE_TTL_MS = 30_000;

/** How long a waiting caller sleeps between re-reads while someone else refreshes. */
export const REFRESH_POLL_INTERVAL_MS = 250;

/** Total time a waiting caller spends polling before it answers 503. */
export const REFRESH_POLL_BUDGET_MS = 3_000;

/** Real timer. `GetOrRefreshOpts.sleep` replaces it so tests never wait. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/*                                  Errors                                    */
/* -------------------------------------------------------------------------- */

/**
 * No credential document at all — the conta was never connected, or an operator
 * deleted it. Terminal for this call: only a new consent can fix it, so
 * `respond.ts` maps it to `409 SHOPEE_REAUTH_REQUIRED`.
 *
 * ⚠️ App-local, and deliberately NOT a `ShopeeError` subclass (like the two
 * classes this app already owns): it describes OUR storage, not Shopee's wire.
 * The cost of that choice is that `respond.ts`'s positive list has to name it —
 * a class forgotten there falls past the route catch and 500s.
 */
export class ShopeeSemCredencialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopeeSemCredencialError';
  }
}

/**
 * The conta is connected, but the consent was main-account-scoped, so there is
 * no `shop_id` to sign a shop call with.
 *
 * ⚠️ A legitimate connected state, not a failure of the conta: the conta route
 * renders it. Only the members that actually NEED a shop-signed token raise it.
 */
export class ShopeeContaSemShopIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopeeContaSemShopIdError';
  }
}

/**
 * Someone else is refreshing this conta's token right now and did not finish
 * inside our poll budget. Transient — `respond.ts` answers `503` with a
 * `Retry-After`, because the very next call will almost certainly find the fresh
 * pair.
 */
export class ShopeeRefreshEmAndamentoError extends Error {
  /** Milliseconds since epoch — when the holder's lease may be taken over. */
  readonly leaseExpiraEm: number;

  constructor(message: string, leaseExpiraEm: number) {
    super(message);
    this.name = 'ShopeeRefreshEmAndamentoError';
    this.leaseExpiraEm = leaseExpiraEm;
  }
}

/* -------------------------------------------------------------------------- */
/*                            The port and its outcomes                       */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ Every outcome is a VERDICT, never a payload plus a flag. A caller that has
 * to ask two questions to know what happened is a caller that will one day ask
 * only the first.
 */
export type AcquireOutcome =
  /** No credential document, or one with no refresh token to spend. */
  | { readonly kind: 'ausente' }
  /** The stored token outlives the skew — nothing to do, and nothing written. */
  | { readonly kind: 'fresh'; readonly accessToken: string }
  /** Someone else holds a live lease. Nothing written. */
  | { readonly kind: 'held'; readonly leaseExpiraEm: number }
  /** The lease is ours; this is the refresh token to spend. */
  | { readonly kind: 'acquired'; readonly refreshToken: string };

export type CommitOutcome =
  /** The document vanished (or became unusable) while we refreshed. */
  | { readonly kind: 'ausente' }
  /** Our pair is stored; this token is now the one on disk. */
  | { readonly kind: 'committed'; readonly accessToken: string }
  /** A newer pair beat ours; OUR pair was dropped and the stored token returned. */
  | { readonly kind: 'descartado'; readonly accessToken: string };

export type ReleaseOutcome =
  | { readonly kind: 'ausente' }
  /** The lease is gone (or was never ours). The caller's original failure stands. */
  | { readonly kind: 'liberado' }
  /** A newer pair landed while we failed — use it, and stamp nothing. */
  | { readonly kind: 'adotado'; readonly accessToken: string };

/**
 * A refresh failure, reduced to what may be persisted.
 *
 * ⚠️ `codigo` is Shopee's own `error` string (or one of the two synthetic codes
 * below), and NEVER a token, a token fragment or a response body.
 */
export interface FalhaRefresh {
  readonly codigo: string;
  /** `true` only when a retry cannot help — the seller must consent again. */
  readonly terminal: boolean;
}

/** Synthetic code for a failure that never reached Shopee's error envelope. */
const CODIGO_CREDENCIAL_INVALIDA = 'credencial_invalida';

export interface ShopeeLeasedTokenStore {
  /** The `current` credential, uncached, or `null` when nothing is stored. */
  load(): Promise<CredenciaisIntegracao | null>;
  acquire(
    owner: string,
    nowMs: number,
    leaseTtlMs: number,
    skewMs: number,
  ): Promise<AcquireOutcome>;
  commit(
    owner: string,
    refreshTokenGasto: string,
    pair: ShopeeTokenPair,
    nowMs: number,
  ): Promise<CommitOutcome>;
  releaseOrAdopt(
    owner: string,
    refreshTokenGasto: string,
    nowMs: number,
    falha: FalhaRefresh | null,
  ): Promise<ReleaseOutcome>;
}

/** Clearing writes `null`, never `undefined` — see the credentialStore header. */
const LEASE_LIMPO = { refreshLeaseOwner: null, refreshLeaseExpiraEm: null } as const;

export function createShopeeTokenStore(
  db: Firestore,
  integracaoId: string,
): ShopeeLeasedTokenStore {
  const ctx = { integracaoId };
  const credentials = createShopeeCredentialStore(db, integracaoId);
  const docRef = (): DocumentReference =>
    credenciaisIntegracaoCollection.docRef(db, ctx, SHOPEE_CREDENCIAL_DOC_ID);
  const docPath = credenciaisIntegracaoCollection.docPath(ctx, SHOPEE_CREDENCIAL_DOC_ID);

  const lerArmazenado = (raw: unknown): CredenciaisIntegracao =>
    credenciaisIntegracaoCollection.parseRead(raw, docPath);

  return {
    load: () => credentials.load(),

    /**
     * Claim the right to refresh — **class A**.
     *
     * Every verdict comes off the ONE `tx.get` inside the callback, so a retried
     * attempt re-decides instead of replaying what the first one saw.
     *
     * ⚠️ Two different mechanisms exclude two different competitors, and the
     * lease alone covers neither:
     *
     *  - Two callers that read version N **at the same time** are arbitrated by
     *    OCC: one commits, the other ABORTS, re-runs the callback against the
     *    winner's document and comes back `held`. The lease plays no part.
     *  - The caller arriving AFTER that commit sees a stable document; only the
     *    stored lease can tell it that a refresh is in flight.
     */
    async acquire(owner, nowMs, leaseTtlMs, skewMs) {
      // Built before the callback opens, but derived from ARGUMENTS only — no
      // read feeds it, so a retry re-applying it verbatim is exactly right.
      const patch = credenciaisIntegracaoCollection.parseMerge({
        refreshLeaseOwner: owner,
        refreshLeaseExpiraEm: nowMs + leaseTtlMs,
      });

      return db.runTransaction(async (tx): Promise<AcquireOutcome> => {
        const snap = await tx.get(docRef());
        if (!snap.exists) return { kind: 'ausente' };
        const stored = lerArmazenado(snap.data());

        // A concurrent refresh may have landed since our fast path read.
        const expiraEm = expiryOf(stored);
        const accessToken = accessTokenOf(stored);
        if (accessToken !== null && expiraEm !== null && expiraEm - nowMs > skewMs) {
          return { kind: 'fresh', accessToken };
        }

        const lease = leaseOf(stored);
        // ⚠️ `nowMs < expiraEm`: an expiry that has arrived is EXPIRED and
        // takeable. And a lease bearing our OWN owner id is re-entrant recovery
        // from an OCC retry, never a competitor.
        if (lease !== null && lease.owner !== owner && nowMs < lease.expiraEm) {
          return { kind: 'held', leaseExpiraEm: lease.expiraEm };
        }

        const refreshToken = refreshTokenOf(stored);
        // A document with no spendable refresh token cannot be renewed at all;
        // only a new consent fixes it, which is what `ausente` tells the caller.
        if (refreshToken === null) return { kind: 'ausente' };

        tx.update(docRef(), patch);
        return { kind: 'acquired', refreshToken };
      });
    },

    /**
     * Persist the pair Shopee just minted — **class C**, guard named below.
     *
     * The pair comes from a network round trip, so nothing about it can be
     * re-derived inside the callback. What IS re-derived is the decision: the
     * stored `refresh_token` is compared against the one we spent.
     */
    async commit(owner, refreshTokenGasto, pair, nowMs) {
      // ⚠️ Built BEFORE the transaction opens, both variants. A blank
      // `refresh_token` from Shopee therefore fails HERE — on the release path,
      // where the lease is handed back — instead of throwing inside the callback
      // with the lease still held for its full TTL.
      const campos = {
        access_token: pair.accessToken,
        refresh_token: pair.refreshToken,
        // ms in, ms out: `expiresAtFrom` did the seconds→ms conversion in the
        // package, and nothing here converts anything a second time (rule 7).
        expirationDate: pair.expiresAtMs - EXPIRY_GUARD_MS,
        obtidoEm: nowMs,
        ultimoRefreshEm: nowMs,
        // A success clears the stamp the panel renders.
        ultimaFalhaRefresh: null,
      };
      const patch = credenciaisIntegracaoCollection.parseMerge(campos);
      const patchLiberandoLease = credenciaisIntegracaoCollection.parseMerge({
        ...campos,
        ...LEASE_LIMPO,
      });

      // An ARRAY rather than a captured `let`: the callback is re-run on an OCC
      // retry, so the log line must describe the attempt that actually decided.
      const descartes: { readonly expiraEmArmazenado: number | null }[] = [];

      const outcome = await db.runTransaction(async (tx): Promise<CommitOutcome> => {
        descartes.length = 0;
        const snap = await tx.get(docRef());
        // Never resurrect a deleted credential: an operator who disconnected the
        // conta mid-refresh must not get it back as a side effect.
        if (!snap.exists) return { kind: 'ausente' };
        const stored = lerArmazenado(snap.data());

        // ⚠️ THE GUARD: the stored `refresh_token` must still be the one we
        // spent. It is an IDENTITY comparison, not a clock — there is no unit to
        // get wrong (rule 7's cross-unit trap cannot apply), and it is the token
        // rather than the lease on purpose: if our lease expired and another
        // instance re-took it but has not written yet, the stored refresh token
        // is still ours and OUR pair is the live one.
        //
        // ⚠️ FAQ 144 vs the API page (the contradiction the module header names).
        // Under FAQ 144 a re-sent refresh token returns the SAME new pair, so
        // this drop costs one wasted call; under the API page's "once only" the
        // second send burns the pair. The accepted residual is a crash BETWEEN
        // Shopee's answer and this commit: the pair we were handed is lost, and
        // the next caller re-sends the OLD refresh token once the TTL elapses —
        // which heals under FAQ 144 and forces a re-consent under "once only".
        // Narrowing that window further would mean writing before the provider
        // answers, which is a worse trade.
        if (refreshTokenOf(stored) !== refreshTokenGasto) {
          descartes.push({ expiraEmArmazenado: expiryOf(stored) });
          const accessToken = accessTokenOf(stored);
          // The lease is NOT touched here: it is not ours any more.
          // A stored token we cannot serve is, to this caller, no credential.
          return accessToken === null ? { kind: 'ausente' } : { kind: 'descartado', accessToken };
        }

        // Clear the lease only while it is still ours — a lease another instance
        // has already taken over is that instance's to release.
        const lease = leaseOf(stored);
        const nossa = lease !== null && lease.owner === owner;
        // `update`, never `set`: the refresh response echoes no `shop_id_list` /
        // `merchant_id_list`, so a full-document write would wipe them.
        tx.update(docRef(), nossa ? patchLiberandoLease : patch);
        return { kind: 'committed', accessToken: pair.accessToken };
      });

      const descarte = descartes[0];
      if (descarte !== undefined) {
        // OUTSIDE the callback: a retried attempt would otherwise log one line
        // per attempt for a single decision. Ids and clocks only — never a
        // token, and never a prefix or a suffix of one (#1015).
        console.warn(
          '[shopee/token] par descartado: a credencial armazenada mudou durante a renovação',
          { integracaoId, nowMs, expiraEmArmazenado: descarte.expiraEmArmazenado },
        );
      }
      return outcome;
    },

    /**
     * Hand the lease back after a failure — **class C**.
     *
     * ⚠️ The adoption arm runs BEFORE any terminal verdict is written. A reauth
     * code answered against a refresh token that has SINCE been replaced (by
     * another instance, or by an operator re-consenting) says nothing about the
     * pair now on disk, and stamping it would disconnect a conta that is in fact
     * healthy — the FAQ 144 hedge, in its most expensive direction.
     */
    async releaseOrAdopt(owner, refreshTokenGasto, nowMs, falha) {
      return db.runTransaction(async (tx): Promise<ReleaseOutcome> => {
        const snap = await tx.get(docRef());
        if (!snap.exists) return { kind: 'ausente' };
        const stored = lerArmazenado(snap.data());

        const lease = leaseOf(stored);
        const nossa = lease !== null && lease.owner === owner;

        if (refreshTokenOf(stored) !== refreshTokenGasto) {
          if (nossa) {
            tx.update(docRef(), credenciaisIntegracaoCollection.parseMerge({ ...LEASE_LIMPO }));
          }
          const accessToken = accessTokenOf(stored);
          return accessToken === null ? { kind: 'liberado' } : { kind: 'adotado', accessToken };
        }

        // Not ours: nothing to release, and stamping someone else's attempt
        // would be a diagnosis about a refresh we did not run.
        if (!nossa) return { kind: 'liberado' };

        // ⚠️ `ultimaFalhaRefresh` is written WHOLESALE as a nested map. On
        // `tx.update` a top-level key REPLACES the whole map rather than merging
        // into it, which is exactly what a stamp wants: the newest failure, never
        // a blend of two.
        //
        // Only a terminal failure is stamped. A transient one releases without a
        // trace, so the panel cannot flap red on a rate limit or a hiccup.
        const patch =
          falha?.terminal === true
            ? {
                ...LEASE_LIMPO,
                ultimaFalhaRefresh: { em: nowMs, codigo: falha.codigo, terminal: true },
              }
            : { ...LEASE_LIMPO };
        tx.update(docRef(), credenciaisIntegracaoCollection.parseMerge(patch));
        return { kind: 'liberado' };
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                          getOrRefreshAccessToken                           */
/* -------------------------------------------------------------------------- */

export interface ShopeeTokenDeps {
  readonly store: ShopeeLeasedTokenStore;
  readonly config: ShopeeOAuthConfig;
  readonly subject: ShopeeRefreshSubject;
  readonly integracaoId: string;
}

export interface GetOrRefreshOpts {
  /** Injected clock, milliseconds. Re-read at every decision point. */
  readonly now?: () => number;
  readonly skewMs?: number;
  readonly leaseTtlMs?: number;
  readonly pollIntervalMs?: number;
  readonly pollBudgetMs?: number;
  /** Injectable for tests; defaults to the package's real refresh call. */
  readonly refresh?: (
    config: ShopeeOAuthConfig,
    refreshToken: string,
    subject: ShopeeRefreshSubject,
  ) => Promise<ShopeeTokenPair>;
  /** Injectable for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Injectable for tests. A **per-attempt** id, never an instance id: two
   * concurrent calls on one instance must be able to tell their leases apart.
   */
  readonly newLeaseOwner?: () => string;
}

/**
 * Map a refresh failure onto what may be persisted, narrowing on the package's
 * own classes (root CLAUDE.md rule 6 — `instanceof Error` would not count).
 *
 * `null` means "not a Shopee failure we can classify": the lease is still
 * released, nothing is stamped, and the original error is rethrown untouched.
 *
 * ⚠️ Most-derived FIRST. `ShopeeReauthRequiredError` and `ShopeeRateLimitError`
 * both extend `ShopeeApiError`, so testing the base first would stamp a rate
 * limit as terminal and disconnect a healthy conta.
 */
function classificarFalha(err: unknown): FalhaRefresh | null {
  if (err instanceof ShopeeReauthRequiredError) return { codigo: err.code, terminal: true };
  if (err instanceof ShopeeRateLimitError) return { codigo: err.code, terminal: false };
  if (err instanceof ShopeeApiError) return { codigo: err.code, terminal: false };
  if (err instanceof ShopeeSchemaError) return { codigo: 'schema_invalido', terminal: false };
  if (err instanceof ShopeeNetworkError) return { codigo: 'network', terminal: false };
  if (err instanceof ShopeeHttpError) return { codigo: 'http', terminal: false };
  // Raised by the pre-transaction patch build when Shopee's pair does not
  // satisfy the credential schema (a blank `refresh_token`, above all).
  if (err instanceof z.ZodError) return { codigo: CODIGO_CREDENCIAL_INVALIDA, terminal: false };
  return null;
}

/**
 * A live Shopee access token for this conta: the stored one while it outlives
 * the skew, otherwise a freshly refreshed one.
 *
 * Guarantees, in the order they matter:
 *
 *  1. **At most ONE provider call per invocation, on every path.** Not one per
 *     retry, not one per poll iteration — the refresh is never retried here.
 *     Transient failures are the CALLER's retry, because only the caller knows
 *     whether the operation is worth repeating.
 *  2. **The pair is stored BEFORE the token is returned.** A token handed to a
 *     caller that nobody could refresh afterwards is the legacy defect.
 *  3. **The lease is released on every exit**, including the throwing ones.
 *
 * Throws {@link ShopeeSemCredencialError} (409, reconnect),
 * {@link ShopeeRefreshEmAndamentoError} (503, retry shortly),
 * `ShopeeCredencialInvalidaError` (502, Shopee's pair did not validate), or the
 * ORIGINAL provider error instance for anything else.
 */
export async function getOrRefreshAccessToken(
  deps: ShopeeTokenDeps,
  opts: GetOrRefreshOpts = {},
): Promise<string> {
  const { store, config, subject, integracaoId } = deps;
  const now = opts.now ?? Date.now;
  const skewMs = opts.skewMs ?? REFRESH_SKEW_MS;
  const leaseTtlMs = opts.leaseTtlMs ?? REFRESH_LEASE_TTL_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? REFRESH_POLL_INTERVAL_MS;
  const pollBudgetMs = opts.pollBudgetMs ?? REFRESH_POLL_BUDGET_MS;
  const refresh = opts.refresh ?? refreshAccessToken;
  const sleep = opts.sleep ?? defaultSleep;
  const owner = (opts.newLeaseOwner ?? randomUUID)();

  const semCredencial = (): ShopeeSemCredencialError =>
    new ShopeeSemCredencialError(
      `Conta Shopee ${integracaoId} sem credencial utilizável. Reconecte a conta.`,
    );

  /** `true` while this stored pair can still be handed to a caller. */
  const utilizavel = (cred: CredenciaisIntegracao): string | null => {
    const accessToken = accessTokenOf(cred);
    const expiraEm = expiryOf(cred);
    // Strictly greater: a token with EXACTLY the skew left is refreshed.
    return accessToken !== null && expiraEm !== null && expiraEm - now() > skewMs
      ? accessToken
      : null;
  };

  // (0) Fast path — zero writes, zero transactions, zero provider calls.
  const atual = await store.load();
  if (atual === null) throw semCredencial();
  const rapido = utilizavel(atual);
  if (rapido !== null) return rapido;

  // (1) Claim the refresh.
  let claim = await store.acquire(owner, now(), leaseTtlMs, skewMs);

  if (claim.kind === 'held') {
    const limite = now() + pollBudgetMs;
    while (now() < limite) {
      await sleep(pollIntervalMs);
      const durante = await store.load();
      // The conta was disconnected while we waited.
      if (durante === null) throw semCredencial();
      const pronto = utilizavel(durante);
      if (pronto !== null) return pronto;
      const lease = leaseOf(durante);
      // The holder released or crashed — stop waiting and try to take over.
      if (lease === null || now() >= lease.expiraEm) break;
    }
    // ONE more attempt, then give up: a caller that keeps polling a live lease
    // is a caller that will still be polling when the next one arrives.
    claim = await store.acquire(owner, now(), leaseTtlMs, skewMs);
    if (claim.kind === 'held') {
      throw new ShopeeRefreshEmAndamentoError(
        `Renovação do token Shopee da integração ${integracaoId} em andamento. Tente novamente em instantes.`,
        claim.leaseExpiraEm,
      );
    }
  }

  if (claim.kind === 'ausente') throw semCredencial();
  if (claim.kind === 'fresh') return claim.accessToken;

  // (2) The provider call — outside every transaction, exactly once, no retry.
  const refreshTokenGasto = claim.refreshToken;
  let resultado: CommitOutcome;
  try {
    const pair = await refresh(config, refreshTokenGasto, subject);
    // (3) Persist BEFORE returning. `commit` builds its patch before opening its
    // transaction, so a pair that does not validate throws HERE and is handled
    // by the release path below rather than stranding the lease.
    resultado = await store.commit(owner, refreshTokenGasto, pair, now());
  } catch (err) {
    // (4) Release, then decide. Rule 6: every arm below is narrowed on a named
    // class, and anything unrecognised is rethrown as the original instance.
    const falha = classificarFalha(err);
    const saida = await store.releaseOrAdopt(owner, refreshTokenGasto, now(), falha);
    if (saida.kind === 'adotado') return saida.accessToken;
    if (saida.kind === 'ausente') throw semCredencial();
    if (err instanceof z.ZodError) {
      const campos = validationPaths(err.issues);
      throw new ShopeeCredencialInvalidaError(
        `Credencial Shopee inválida para a integração ${integracaoId}. Campos: ${campos.join(', ')}.`,
        campos,
      );
    }
    throw err;
  }

  if (resultado.kind === 'ausente') throw semCredencial();
  // `committed` hands back our pair; `descartado` hands back the winner's.
  return resultado.accessToken;
}
