import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

/** Why a released escrow row could not be settled on the tick that saw it. */
export const motivoPendenteShopeeSchema = z.enum(['sem-pedido', 'sem-pagamento']);
export type MotivoPendenteShopee = z.infer<typeof motivoPendenteShopeeSchema>;

/** Named members of {@link motivoPendenteShopeeSchema}. */
export const MOTIVO_PENDENTE_SHOPEE = {
  semPedido: 'sem-pedido',
  semPagamento: 'sem-pagamento',
} as const satisfies Record<string, MotivoPendenteShopee>;

/**
 * One escrow row whose pagamento could not be settled YET.
 *
 * ⚠️ It carries the WHOLE row, not just the `order_sn`, because the row does not
 * come back once the cursor moves past its release time: `get_escrow_list` is
 * queried BY `escrow_release_time`, so a released order is visible only in the
 * windows that cover it. **This list IS the replay source** — a pendente storing
 * just an id would have nothing to settle with when its pedido finally arrives.
 */
export const liquidacaoPendenteSchema = z.object({
  orderSn: z.string().min(1),
  /**
   * `payout_amount` RAW. A plain `z.number()` and NOT the package's tolerant
   * wire reader: by the time a value reaches this schema it has already been
   * through the wire tolerance once, and this is a WRITE validator for OUR own
   * document — a second layer of tolerance here would only hide our own bug.
   */
  payoutAmount: z.number().nullable().default(null),
  /**
   * ⚠️⚠️ **SECONDS** — the one second-resolution field stored in this channel;
   * the `S` suffix is the safety mechanism. See the collection header below.
   * Converted ONCE at the settlement write, and never with `coerceToMicros`.
   */
  escrowReleaseTimeS: z.number().int().nullable().default(null),
  motivo: motivoPendenteShopeeSchema,
  /** Settlement attempts so far; the sweep DROPS the row past its own maximum. */
  tentativas: z.number().int().min(0).default(0),
});
export type LiquidacaoPendente = z.infer<typeof liquidacaoPendenteSchema>;

/**
 * `liquidacaoShopee` (TOP-LEVEL) — the per-conta durable cursor for the WEEKLY
 * Shopee settlement sweep (master-plan step 6, #1514).
 *
 * Shopee pushes nothing when money is released. The only exposure of
 * `escrow_release_time` anywhere in the API is `get_escrow_list`, so the sweep
 * pages that endpoint over a release-time window for every ACTIVE Shopee conta
 * and stamps `pagamento.liquidacao` for each row whose pagamento it can find.
 * This document — ONE per conta, **doc id = integracaoId** — is where a conta's
 * progress and its unfinished business survive across ticks. There is no legacy
 * antecedent: the Flutter app modeled `get_escrow_list` and never called it.
 *
 * ## ⚠️ MILLISECONDS at rest — with ONE deliberate exception
 *
 * Every clock in this document is ms and says so in its name, matching
 * `backfillPedidosShopee`, and keeping this document OFF the µs SITE list
 * `apps/shopee/CLAUDE.md` maintains (five sites plus two readers — the
 * "one module that speaks µs" sentence that file used to carry was retired
 * precisely because it had quietly become five). The settlement write is the
 * only place this channel's µs and this document's ms meet. The exception is
 * {@link liquidacaoPendenteSchema}'s `escrowReleaseTimeS`, which is **SECONDS**:
 * it is the wire value held verbatim for replay. It is converted exactly ONCE,
 * at the settlement write, through the channel's seconds helper — **never
 * `coerceToMicros`**, whose magnitude heuristic reads a seconds value as 1970,
 * which would make every stored release stamp look older than every incoming one
 * for ever and turn the settlement watermark into a guard that never rejects
 * anything (root `CLAUDE.md` rule 7).
 *
 * ## Write discipline (the sweep's — the fields only make sense together)
 *
 * ONE merge per conta per tick, and the sweep is this document's only writer:
 *
 *  - **drained** (`more === false`) ⇒ `cursorMs = max(stored, windowTo)`, the
 *    pending window and page cleared, `lastError: null`. The cursor advances to
 *    the WINDOW's upper bound, never to `nowMs`: the band above it was never
 *    queried, and claiming it would skip whatever lands there.
 *  - **truncated** (the per-tick page or liquidation budget) ⇒ persist
 *    `{ pendingWindowFromMs, pendingWindowToMs, pendingPageNo }` and advance
 *    NOTHING. Without that triple a conta whose week exceeds the budget would
 *    re-read the same first pages for ever, silently.
 *  - **contained conta error** ⇒ `{ lastSweepAtMs, lastError }` only — never the
 *    cursor. A 30-second outage must not skip a week of money and then advance
 *    past it.
 *
 * The window starts one overlap before the cursor, so every tick re-covers that
 * band; the repeat is free because the settlement transaction's no-change branch
 * writes nothing at all.
 *
 * ## Admin-only / default-deny
 *
 * Permissions are `0n` and the schema is deliberately NOT registered in
 * `ALL_DOMAINS` (see the NOTE at the bottom), so the rules generator emits no
 * match block, Firestore default-denies every client read/write, and no rules
 * regeneration is needed for this file. Only the nested `apps/shopee/functions`
 * codebase (Admin SDK) ever touches this collection.
 *
 * ⚠️ The settlement-SOURCE vocabulary is deliberately NOT re-declared here: it is
 * `LIQUIDACAO_FONTE`, in `pedido/collection/pagamento.ts`, beside the field it
 * validates. Two constants holding the same wire token in two files is the drift
 * shape root `CLAUDE.md` warns about.
 */
export const liquidacaoShopeeSchema = z.object({
  /**
   * High-water mark (MS) of `escrow_release_time` covered by a fully DRAINED
   * window — the next tick queries from `cursorMs - OVERLAP`. Null until the
   * conta's first drained window (the first tick falls back to the initial
   * lookback).
   */
  cursorMs: millisSinceEpoch().nullable().default(null),
  /**
   * The exact window {@link liquidacaoShopeeSchema}'s `pendingPageNo` resumes
   * into. A page number is meaningless without it: applying one to a RECOMPUTED
   * window (the clock has moved) resumes into a different result set, which is a
   * silent skip. The three are written and cleared together.
   */
  pendingWindowFromMs: millisSinceEpoch().nullable().default(null),
  pendingWindowToMs: millisSinceEpoch().nullable().default(null),
  /**
   * Where to resume paging inside the pending window. Meaningful only alongside
   * that window AND a fixed page size — which is why the sweep always SENDS
   * `page_size` instead of relying on Shopee's default.
   */
  pendingPageNo: z.number().int().min(1).nullable().default(null),
  /** When the sweep last touched this conta (MS) — set on success AND on a contained error. */
  lastSweepAtMs: millisSinceEpoch().nullable().default(null),
  /** The last contained per-conta sweep error; reset to null on a clean tick. */
  lastError: z.string().nullable().default(null),
  /**
   * Rows seen released whose pagamento was not there yet. BOUNDED by the sweep
   * (oldest-first eviction, counted and logged) — an unbounded array in a
   * document is a 1 MiB cliff. The schema deliberately does NOT declare that
   * cap: the ceiling is a budget the sweep owns and tunes, and a stored document
   * that already exceeds it must still PARSE, or the sweep could not trim it.
   */
  pendentes: z.array(liquidacaoPendenteSchema).default([]),
});
export type LiquidacaoShopee = z.infer<typeof liquidacaoShopeeSchema>;

export const liquidacaoShopeeMeta: CollectionMetadata = {
  collectionPath: 'liquidacaoShopee',
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
// (`liquidacaoShopeeCollection`) consumes `liquidacaoShopeeMeta.collectionPath`
// directly.
//
// ⚠️ The collection name deliberately does not start with `notificacoes`:
// `notificationGuardrails`' checks B and C fire on every admin collection path
// with that prefix and would demand a pipeline consumer and a
// `(status, processedAt)` index this cursor doc has neither of.
