import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

/**
 * `estoqueShopeeSync` (TOP-LEVEL) — the per-conta durable state doc for the
 * flag-gated Shopee stock-sync sweeps (master-plan step 12, #1520).
 *
 * Three tiers share this one document: the quarter-hourly INCREMENTAL sweep,
 * the nightly DIÁRIO pass and the monthly RECONCILIAÇÃO. Each discovers the
 * changed produto families for a conta, computes every quantity at sweep time
 * and enqueues one Cloud Task per `update_stock` call (the task payload CARRIES
 * the quantities — the send handler transmits them verbatim and never re-reads
 * stock). This document — ONE per conta, **doc id = integracaoId** — is where a
 * conta's progress, health and pause survive across ticks.
 *
 * ## ⚠️ MILLISECONDS, and the unit is in every field name
 *
 * `apps/shopee/CLAUDE.md` inventories the channel's microsecond modules and
 * this is deliberately not a new one: every stamp here is ms, matching
 * `backfillPedidosShopee` and `liquidacaoShopee`. It deliberately does NOT
 * mirror `estoqueMercadoLivreSync`'s microsecond spellings — root `CLAUDE.md`
 * rule 7's own words are that a cross-unit comparison is "a guard that never
 * fires", and the only clocks this document is ever compared against (the
 * sweep's `nowMs`, the task payload's stamps, the link docs' stamps) are all
 * ms.
 *
 * ## ONE gate, ONE continuation
 *
 * {@link estoqueShopeeSyncSchema}'s `pausadoAte` is the SINGLE pause field.
 * A separate daily-quota field was rejected on purpose: two gate fields are two
 * readers that can disagree, and all three consumers (the sweep's per-conta
 * skip, the send task's pause rung, the manual route's 409 pre-check) would
 * each have to consult both and pick a maximum. One instant plus a
 * `pausaMotivo` that carries the
 * distinction is strictly more informative and strictly harder to get wrong.
 *
 * ## Write discipline (the sweeps' + the send handler's — documented here
 * because the fields only make sense together)
 *
 * Every write is a `merge` (create-on-first-use for a per-account state doc),
 * never a conditional update:
 *
 *  - **drained incremental** ⇒ `{ cursorMs: startedAtMs, continuacao: null,
 *    lastSweepAtMs, lastError: null, ultimoMotivoConta: null }`. The cursor
 *    advances to the sweep's OWN start, never to `nowMs`: the window was
 *    covered exactly up to the instant the sweep began, and claiming anything
 *    past it would skip whatever landed while it ran.
 *  - **drained diário / reconciliação** ⇒ `{ lastDailyAtMs | lastReconciliacaoAtMs,
 *    continuacao: null, lastSweepAtMs, lastError: null }` — **never `cursorMs`**.
 *    Those tiers do not define the incremental floor and must not move it.
 *  - **truncated** (page cap or task cap) ⇒ `{ continuacao, lastSweepAtMs }` and
 *    advances NOTHING. The next tick RESUMES the frozen sweep rather than
 *    restarting page 1 of a re-derived window, which is how a conta with a
 *    standing backlog would otherwise never reach its tail.
 *  - **contained per-conta error** ⇒ `{ lastError, lastErrorAtMs, lastSweepAtMs }`
 *    — never the cursor, never the continuation. The next tick retries the same
 *    window, and re-covering is harmless because the re-run recomputes every
 *    quantity at ITS OWN sweep time.
 *  - **gated conta** (a conta the pre-checks refused whole) ⇒
 *    `{ ultimoMotivoConta, ultimoMotivoContaEmMs, lastSweepAtMs }` only.
 *  - **pause** (the send handler, on a rate limit / daily quota / holiday mode /
 *    blocked shop) ⇒ `{ pausadoAte, pausaMotivo, pausaCodigo, pauseCount + 1 }`.
 *
 * ## Admin-only / default-deny
 *
 * Permissions are `0n` and the schema is deliberately NOT registered in
 * `ALL_DOMAINS` (see the NOTE at the bottom), so the rules generator emits no
 * match block, Firestore default-denies every client read/write, and no rules
 * regeneration is needed. Only the nested `apps/shopee/functions` codebase
 * (Admin SDK) ever touches this collection.
 */

/**
 * Which tier froze a `continuacao`, and
 * therefore which send policy the RESUMED tick runs under.
 *
 * Recorded explicitly rather than inferred from a sibling field: the ML
 * precedent used to derive "daily vs incremental" from a nullable cutoff and
 * had to be corrected, because a field that doubles as a discriminator stops
 * being readable the moment its first meaning changes.
 */
export const modoVarreduraEstoqueSchema = z.enum(['incremental', 'diario', 'reconciliacao']);
export type ModoVarreduraEstoque = z.infer<typeof modoVarreduraEstoqueSchema>;

/** Named members of {@link modoVarreduraEstoqueSchema} — see `delfrance/prefer-schema-enum`. */
export const MODO_VARREDURA_ESTOQUE = {
  incremental: 'incremental',
  diario: 'diario',
  reconciliacao: 'reconciliacao',
} as const satisfies Record<string, ModoVarreduraEstoque>;

export const estoqueShopeeSyncSchema = z.object({
  /**
   * MS. High-water mark of a fully DRAINED incremental window — the next tick
   * queries estoque changes from here (minus the overlap slack), capped by the
   * max lookback. Null until the conta's first drained incremental sweep, which
   * falls back to the default window instead. **The diário and the
   * reconciliação never touch it.**
   */
  cursorMs: millisSinceEpoch().nullable().default(null),
  /** MS. When ANY tier last finished a tick for this conta — success, gate or contained error. */
  lastSweepAtMs: millisSinceEpoch().nullable().default(null),
  /** MS. When the nightly diário pass last completed for this conta. */
  lastDailyAtMs: millisSinceEpoch().nullable().default(null),
  /**
   * MS. When the monthly reconciliação last completed for this conta.
   *
   * ⚠️ **Report only — NEVER a baseline.** The reconciliação FORCE-SENDS every
   * discovered family rather than diffing against a previous pass, so nothing
   * reads this field to decide what to send. It exists so an operator can tell
   * "a full pass ran" from "a full pass was due and silently skipped", and
   * reusing {@link lastDailyAtMs} for it would claim the first while meaning
   * the second.
   */
  lastReconciliacaoAtMs: millisSinceEpoch().nullable().default(null),
  /** The last contained per-conta error; reset to null on a clean tick. */
  lastError: z.string().nullable().default(null),
  /** MS. When {@link lastError} was recorded — outlives the reset-to-null on recovery. */
  lastErrorAtMs: millisSinceEpoch().nullable().default(null),
  /**
   * MS. **THE ONE GATE.** While `pausadoAte > now` the sweep skips this conta
   * whole (cursor and continuação untouched), the send task re-enqueues itself
   * instead of calling Shopee, and the manual route pre-checks it and answers
   * 409 BEFORE constructing a client. One throttled or blocked conta never
   * halts the healthy ones.
   *
   * Always an EXPIRY, never a latch: a conta that Shopee refuses outright
   * (holiday mode, a blocked shop, a fulfilment kind that cannot take a
   * seller-stock write) is paused for a day rather than flagged forever,
   * because a latch would need a human clearer this app does not have.
   */
  pausadoAte: millisSinceEpoch().nullable().default(null),
  /**
   * Why the pause was armed. The vocabulary is `'burst'` (the app-wide rate
   * limit), `'cota-diaria'` (the daily call quota, which resets on Shopee's own
   * clock), `'loja-em-ferias'` (holiday mode) and `'loja-bloqueada'` (the shop
   * cannot take a seller-stock write at all).
   *
   * ⚠️ A loose string, not an enum, for the reason `falhaPublicacao.motivo` is
   * one (`produto/collection/shopeeLink.ts`): the closed vocabulary lives
   * beside the sender that writes it, and a slug added there must not need a
   * schema change to be persisted.
   */
  pausaMotivo: z.string().nullable().default(null),
  /** Shopee's code VERBATIM, prefix and all, or null when the pause is ours. */
  pausaCodigo: z.string().nullable().default(null),
  /** How many pauses this conta has accumulated (observability counter, advisory). */
  pauseCount: z.number().int().default(0),
  /**
   * Why NOTHING went out for this conta on the last tick — a
   * `MotivoEstoqueShopee` slug, a loose string for the same reason
   * {@link pausaMotivo} is. Cleared on a drained incremental sweep, so a stale
   * reason never outlives the condition that produced it.
   */
  ultimoMotivoConta: z.string().nullable().default(null),
  /** MS. When {@link ultimoMotivoConta} was recorded. */
  ultimoMotivoContaEmMs: millisSinceEpoch().nullable().default(null),
  /**
   * The frozen keyset position + window of a **TRUNCATED** sweep. A sweep that
   * hits the page cap or the task cap stores where it stopped
   * (`afterAnchorId`) together with the window it was running
   * (`changedSinceMs`), the tier whose semantics it froze (`modo`), the ledger
   * window it sums over (`movimentosDesdeMs`) and the ORIGINAL sweep's start
   * (`startedAtMs`); the next tick resumes THAT SAME sweep — same window, same
   * send policy — instead of restarting page 1 of a re-derived window. Cleared
   * (`null`) the moment the continuation drains; an incremental continuation
   * then advances {@link cursorMs} to `startedAtMs`, because the frozen window
   * is covered exactly up to the original sweep's start.
   */
  continuacao: z
    .object({
      /** Keyset cursor: THE query resumes after this produto anchor id. */
      afterAnchorId: z.string().min(1),
      /**
       * MS. The frozen discovery window start the truncated sweep used.
       *
       * ⚠️ A reconciliação freezes **−1** here — the force-all sentinel, not an
       * instant. It is a legitimate value, so nothing may treat a non-positive
       * `changedSinceMs` as malformed.
       */
      changedSinceMs: millisSinceEpoch(),
      /** The frozen tier — decides the resumed tick's send policy. */
      modo: modoVarreduraEstoqueSchema,
      /**
       * MS. The frozen LEDGER window the resumed tick sums movements over.
       *
       * ⚠️ **ALWAYS `null` on `reconciliacao`** — that tier force-sends and has
       * no baseline to sum against; see {@link lastReconciliacaoAtMs}. Distinct
       * from `changedSinceMs`, which a reconciliação sets to `-1`.
       *
       * ⚠️ The key is **REQUIRED from day one**. There is no previous release
       * of this document, so no continuation can exist without it, and there is
       * therefore no inheritance rule to write: a stored continuation missing
       * the key is malformed and the tick runs its own freshly derived window,
       * which is the safe direction.
       */
      movimentosDesdeMs: millisSinceEpoch().nullable(),
      /** MS. When the ORIGINAL (pre-truncation) sweep started. */
      startedAtMs: millisSinceEpoch(),
    })
    .passthrough()
    .nullable()
    .default(null),
});
export type EstoqueShopeeSync = z.infer<typeof estoqueShopeeSyncSchema>;

export const estoqueShopeeSyncMeta: CollectionMetadata = {
  collectionPath: 'estoqueShopeeSync',
  // No client domain grants these bits — placeholder values. Deliberately NOT
  // registered in `ALL_DOMAINS`, so the rules generator emits no match block
  // and Firestore default-denies every client read/write. Only the Admin SDK
  // (apps/shopee nested functions) reaches it. Mirrors
  // `backfillPedidosShopeeMeta`.
  permissions: {
    read: 0n,
    write: 0n,
    delete: 0n,
  },
};

// NOTE: intentionally exported as two BARE constants (`...Schema` + `...Meta`),
// NOT a single `{ schema, meta }` DomainSchema object, and NOT added to
// `ALL_DOMAINS` — `registry.test.ts`'s `isDomainSchema()` only flags a single
// export carrying both a `.schema` and a `.meta` property, so this shape never
// gets swept in by accident. The admin collection handle
// (`estoqueShopeeSyncCollection`) consumes
// `estoqueShopeeSyncMeta.collectionPath` directly.
//
// ⚠️ The collection name deliberately does not start with `notificacoes`:
// `notificationGuardrails`' checks B and C fire on every admin collection path
// with that prefix and would demand a pipeline consumer and a
// `(status, processedAt)` index this state doc has neither of.
