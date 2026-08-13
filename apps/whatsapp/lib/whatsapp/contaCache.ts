/**
 * Process-scoped caches for the WhatsApp `integracao` account — the document
 * itself, and the `wa_id` lookup that resolves an inbound message to it.
 *
 * A leaf module rather than two module-private caches: the writers that must
 * evict (the verification route and the health self-heal) and the query that
 * goes stale (`resolveConta`, in `processMessages.ts`) sit across existing
 * import edges, so a cache in either module would force a cycle. Same shape as
 * the Mercado Livre `contaCache` and the Mercado Pago `metodoCache`.
 *
 * ⚠️ `readWhatsappConta` performs NO tipo check. It replaces the read, not the
 * contract — every caller keeps its own guard.
 *
 * ⚠️ The Graph credential is NOT here and must never be. It lives in the
 * `integracao/{id}/credenciaisWhatsapp` subcollection behind
 * `createCredentialStore`, which re-reads it on every `resolveToken()`.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  READ_CACHE_TTL,
  createCachedDocReader,
  createReadCache,
} from '@delfrance/data/admin/cache';
import { integracaoCollection } from '@delfrance/data/admin/collections';

/**
 * Injectable clock. The primitive captures `opts.now` once at construction —
 * import time for a module-scope cache — so both caches read this binding
 * through an arrow rather than handing over the reference, which would freeze
 * it. Production never moves it.
 */
let nowFn: () => number = Date.now;

/**
 * The `integracao` account document.
 *
 * The repeats, by volume: one per OUTBOUND message (including every stale
 * message re-driven by the 15-minute `sweepStaleOutbound`, which is exactly the
 * burst single-flight exists for), one per inbound webhook carrying media, plus
 * the health aggregator and eight routes.
 *
 * ⚠️ `negativeTtlMs: 0` is MANDATORY here, not stylistic. A cached absence
 * reaches the outbound dispatcher, where `WhatsappContaNotConfiguredError` marks
 * the message `estadoEnvio = erro` — and `erro` is TERMINAL: the stale-outbound
 * sweep only re-drives `salva`/`enviando`, so an operator has to resend by hand.
 * That is an irreversible decision driven by an absent value.
 *
 * ⚠️ NO `isFresh`, deliberately, and NOT for the reason the Mercado Livre and
 * Mercado Pago analogues have one. `verificado` looks like the equivalent field
 * — it is monotonic false→true, every writer checked — but it is a predicate of
 * nothing: it appears in no query in this repo. And an account that works
 * without completing the two-step registration sits at `false` forever, so
 * `isFresh: (c) => c.verificado === true` would refuse EVERY hit for exactly the
 * accounts the cache exists for. Its only consumer is the health self-heal,
 * where a stale `false` costs one redundant idempotent merge.
 */
const contaReader = createCachedDocReader(integracaoCollection, {
  name: 'wa:integracao',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 32,
  negativeTtlMs: 0,
  now: () => nowFn(),
});

/** Outcome of the `wa_id` → account lookup. `limit(2)` makes ambiguity visible. */
export type ContaIdLookup = { kind: 'one'; contaId: string } | { kind: 'none' } | { kind: 'many' };

/**
 * `wa_id` (really the Graph phone-number id) → the owning account's id.
 *
 * Stores the **id**, not the document: the reader above serves the data, so one
 * document is one entry with one clock. The deciding argument is invalidation
 * reach — under "cache the whole conta under a `wa_id` key" no self-write could
 * ever evict it, because `integracaoCollection.merge` knows the document id and
 * not the `wa_id`. The cost is one keyed get on a cold miss, amortized to
 * nothing across a TTL window.
 *
 * `volatile` (60 s), NOT `config`: `wa_id` is an operator-EDITABLE text field,
 * and fixing a typo in it is the operator's remedy for a parked inbound stream.
 * 60 s versus 15 min is the difference between "it started working" and "why is
 * it still broken".
 *
 * `negativeTtlMs: 0` with `isNegative` covering ambiguity too: a miss or a
 * duplicate produces `failed`, which PARKS the notification for the sweep to
 * re-drive later. Cached, that is a customer message sitting unread for the
 * sweep interval plus its staleness window — for a number that connected
 * moments ago.
 */
const contaIdByWaId = createReadCache<readonly [string], ContaIdLookup>({
  name: 'wa:integracao-by-wa-id',
  ttlMs: READ_CACHE_TTL.volatile,
  maxEntries: 32,
  negativeTtlMs: 0,
  isNegative: (value) => value.kind !== 'one',
  now: () => nowFn(),
});

/** The parsed account document, or `null` when it does not exist. */
export function readWhatsappConta(
  db: Firestore,
  integracaoId: string,
): ReturnType<typeof contaReader.get> {
  return contaReader.get(db, {}, integracaoId);
}

/** The cached `wa_id` → account-id lookup. `phoneNumberId` is the only predicate. */
export function readContaIdByWaId(
  phoneNumberId: string,
  load: () => Promise<ContaIdLookup>,
): Promise<ContaIdLookup> {
  return contaIdByWaId.get([phoneNumberId], load);
}

/**
 * Evict after a self-write to `integracao/{id}`. Two writers, both merging
 * `{ verificado: true }`: the verification-confirm route and the health
 * self-heal.
 *
 * The `wa_id` lookup is deliberately NOT evicted — `verificado` is not one of
 * its predicates (it filters on `tipo` + `wa_id` only), so that entry is still
 * correct.
 *
 * ⚠️ Both writers run on the App Hosting backend while `resolveConta` runs in
 * the notification consumer, a different process this cannot reach. That is
 * fine, and for a specific reason rather than a shrug: the only field these
 * writes change is `verificado`, and its only reader is the health route — on
 * the very surface doing the writing. The eviction is placed exactly where the
 * reader is.
 */
export function invalidateWhatsappConta(integracaoId: string): void {
  contaReader.invalidate({}, integracaoId);
}

/**
 * Test-only. The caches are module-scope, and the primitive captures `now` once
 * at construction, so the clock is swapped through this binding rather than
 * passed per test. Pair it with `__resetAllReadCaches()`.
 */
export function __setWhatsappCacheClockForTests(now: () => number = Date.now): void {
  nowFn = now;
}
