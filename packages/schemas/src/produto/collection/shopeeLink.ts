import { z } from 'zod';
import { outerRefSchema } from '../../shared/outerRef';
import { ACAO_STATUS_ANUNCIO, type AcaoStatusAnuncio } from './mercadoLivreLink';

/**
 * Typed write-side schemas for the Shopee listing link docs —
 * `produtos/{id}/prodshopee/{docId}` and
 * `produtos/{id}/variashopee/{docId}` — in the EXACT old Flutter wire shape
 * (`ProdutoShopee` / `VariacaoShopee`, shopee `models.dart`): the migrated
 * corpus is stored in exactly this shape, so it has to be read and written
 * that way.
 *
 * These are deliberately NOT DomainSchemas and NOT in `ALL_DOMAINS`: the loose
 * pass-through subcollection domains in `subcollections.ts` (leaf names
 * `prodshopee` / `variashopee` — verified against the compiled
 * `models.odm.g.dart`, #289) already cover the Firestore rules (client reads,
 * parent produto permissions); these typed shapes exist for the Admin-SDK
 * writer (step 11's publish flow), which bypasses rules but must not drift from
 * the Flutter wire format. Everything step 11 (#1519) and step 12 (#1520) add
 * below is a BARE const on these same two shapes — no `*Meta`, no PERM, no
 * validator whitelist ⇒ **no ruleset regeneration**.
 *
 * ## The writer inventory, whole
 *
 * Only three groups of fields have more than one writer, and none of the three
 * overlap:
 *  - **`item_status` + `estadoAnuncio`** — FOUR writers, enumerated on
 *    {@link shopeeItemStatusSchema} below;
 *  - **the ten `estoque*` scalars** (step 12) — **ONE** writer, the stock
 *    sender. Nothing clears them but the sender's own clean-send path;
 *  - **`kitNativo`** (step 12) — **ONE** writer, step 9's product import.
 * The stock sender READS `item_status` and `estadoAnuncio` into its refusal
 * fingerprint and never writes either, so it can never race the four above.
 *
 * Wire notes (from the parity audit, #289 + #363, corrected by #1519):
 *  - `violations` is what Shopee says is wrong with this listing. The legacy
 *    note called it the outcome of `processarPushShopee` **code 6**; that push
 *    is **RETIRED**. Code 6 is `push_api_id` 4, `banned_item_push`: `guide 18`
 *    names it, `announcement 769` (2023-11-15) and `841` (2024-01-19) ordered
 *    migration away from it, and today's `push-list` Product category is
 *    `5, 11, 13, 18, 25, 30` — no 4. The MODERN push is **`push_api_id` 18 =
 *    push_code 16** (`violation_item_push`), and the same detail also arrives
 *    from the `get_item_violation_info` READ. Neither the create nor the update
 *    flow writes `violations` on a normal publish;
 *  - most nested blobs (`description_info`, `logistic_info`, `wholesale`,
 *    `complaint_policy`, `attributes`) are raw Shopee API pass-through JSON
 *    the audit didn't fully enumerate field-by-field — kept loosely typed
 *    here on purpose (wire tolerance over strictness);
 *  - `violations` items mirror **push 18**'s `item_status_details[]` and
 *    `deboost_details[]` — the same five fields on both sides, with
 *    `suggested_category[]` only on the deboost side. See
 *    {@link shopeeViolacaoSchema}. The legacy `days_to_fix` (a DURATION, from
 *    the retired code-6 payload) stays nullable for the migrated corpus and is
 *    **never derived** from `fix_deadline_time`: that conversion is lossy AND
 *    non-idempotent — the same push replayed a day later yields a different
 *    number.
 */

/**
 * Shopee `item_status` — the SIX wire values (`guide 31` §ItemStatus, and the
 * same list on `get_item_list`, `get_item_base_info`, `search_item`,
 * `get_item_violation_info`, `get_kit_item_info`). Widened from
 * `NORMAL`/`UNLIST` by step 9 (#1517).
 *
 * ⚠️ FOUR writers now, and no ordering guard beyond "last read wins":
 *  - the product IMPORT writes whatever `get_item_base_info` just reported —
 *    step 9 (#1517);
 *  - the publish READ-BACK writes what `get_item_base_info` reports once the
 *    listing has been created or updated — step 11 (#1519);
 *  - pause / re-list (`unlist_item`) and `reverificar-anuncio` write the
 *    read-back of the same call, never the REQUESTED flag: `success_list[].unlist`
 *    is an echo of what we asked for, not a status — step 11;
 *  - the push handlers (push_code 16 and 27) RE-READ `get_item_base_info` and
 *    write that, never a status taken from the push body — step 11.
 * All four write only what they just READ from the one authoritative call, so a
 * replay in any order converges. An earlier revision of this docblock called the
 * field push-only (true before step 9), then said TWO writers (true before step
 * 11). ⚠️ STILL FOUR after step 12 (#1520): the stock sender READS this field
 * into `estoqueRecusaItemStatus` and never writes it — which is also what lets
 * any of the four LIFT a stock refusal simply by doing its job (see
 * {@link produtoShopeeLinkSchema}'s `estoqueRecusaEstado`).
 *
 * ⚠️ The legacy handler FABRICATED `"UNLIST"` because the retired code-6
 * push carried no status at all; push 18 carries the real one and the handler
 * still re-reads it — `guide 18` / `guide 746`: a push never replaces the API.
 *
 * ⚠️ `SELLER_DELETE` / `SHOPEE_DELETE` are members because the wire has them,
 * NOT because anything writes them: the import REFUSES a deleted listing
 * outright (`ShopeeImportBlockedError`, motivo `item-deletado`) — never a
 * produto from a deleted listing — and the push writes only `UNLIST`.
 *
 * ⚠️ The pre-2024 `DELETED` spelling (`announcement 769`/`841`, effective
 * 2024-01-18) is deliberately ABSENT. A migrated link doc may still hold it;
 * nothing on the import path parses a stored link (the existing raw is spread,
 * never `parseRead`), and the first re-import replaces it with a live value.
 * What a stored `DELETED` does today is on record in `shopeeLink.test.ts`:
 * it fails `safeParse`, so `parseSoftRead` (`packages/data/src/zodParse.ts`)
 * logs one warning and hands the RAW document back unchanged — it neither
 * drops the key nor throws.
 */
export const shopeeItemStatusSchema = z.enum([
  'NORMAL',
  'BANNED',
  'UNLIST',
  'REVIEWING',
  'SELLER_DELETE',
  'SHOPEE_DELETE',
]);
export type ShopeeItemStatus = z.infer<typeof shopeeItemStatusSchema>;

/** Named members of {@link shopeeItemStatusSchema} — the Shopee wire codes. */
export const SHOPEE_ITEM_STATUS = {
  normal: 'NORMAL',
  banned: 'BANNED',
  unlist: 'UNLIST',
  reviewing: 'REVIEWING',
  sellerDelete: 'SELLER_DELETE',
  shopeeDelete: 'SHOPEE_DELETE',
} as const satisfies Record<string, ShopeeItemStatus>;

/** Shopee variation `model_status` (models.dart). */
export const shopeeModelStatusSchema = z.enum(['MODEL_NORMAL', 'MODEL_UNAVAILABLE']);
export type ShopeeModelStatus = z.infer<typeof shopeeModelStatusSchema>;

/** Named members of {@link shopeeModelStatusSchema} — the Shopee variation wire codes. */
export const SHOPEE_MODEL_STATUS = {
  normal: 'MODEL_NORMAL',
  unavailable: 'MODEL_UNAVAILABLE',
} as const satisfies Record<string, ShopeeModelStatus>;

/**
 * The FOLDED lifecycle state of one Shopee listing, as the ERP records it
 * (#1519, step 11).
 *
 * ⚠️ This is **not** a wire value and must never be confused with
 * {@link shopeeItemStatusSchema}. `item_status` is Shopee's own six-member
 * response enum; `estadoAnuncio` is what this app decides that reading MEANS,
 * folded from `item_status` + `scheduled_publish_time` + a clock. The fold
 * itself lives in `apps/shopee/lib/shopee/anuncios/statusAnuncio.ts` (pure, the
 * clock as a parameter) — the vocabulary lives here so `apps/web` and the
 * backend cannot disagree about what a stored reading means.
 *
 * Two members carry facts the wire cannot state on its own:
 *  - `agendado` — `UNLIST` with a `scheduled_publish_time` STRICTLY in the
 *    future. The same `UNLIST` with a past-or-absent schedule is `pausado`;
 *  - `desconhecido` — an `item_status` this app does not recognise (including
 *    an absent or empty one). It is a real member, not a hole: refusing to
 *    invent a state is what keeps a Shopee response-enum widening costing one
 *    reading instead of a page.
 *
 * ⚠️ `deboost` is ORTHOGONAL and is a separate field: a deboosted listing is
 * still `ativo` (push 18's own sample carries `NORMAL` + `deboost: true`).
 */
export const estadoAnuncioShopeeSchema = z.enum([
  'ativo',
  'pausado',
  'agendado',
  'banido',
  'em_revisao',
  'removido',
  'desconhecido',
]);
export type EstadoAnuncioShopee = z.infer<typeof estadoAnuncioShopeeSchema>;

/** Named members of {@link estadoAnuncioShopeeSchema}. */
export const ESTADO_ANUNCIO_SHOPEE = {
  ativo: 'ativo',
  pausado: 'pausado',
  agendado: 'agendado',
  banido: 'banido',
  emRevisao: 'em_revisao',
  removido: 'removido',
  desconhecido: 'desconhecido',
} as const satisfies Record<string, EstadoAnuncioShopee>;

/**
 * One violation record — the MODERN shape, shared by `push_api_id` 18
 * (push_code 16, `violation_item_push`) and the `get_item_violation_info` read
 * (#1519).
 *
 * The push carries TWO detail arrays with identical members —
 * `item_status_details[]` (the listing was taken down or held) and
 * `deboost_details[]` (the listing is live but demoted) — and
 * `suggested_category[]` appears only on the deboost side. {@link ShopeeViolacao.kind}
 * is what tells the two apart once they are flattened into one `violations[]`.
 *
 * ⚠️ UNITS. `fix_deadline_time` and `update_time` are **MILLISECONDS here**; the
 * Shopee wire sends SECONDS and the conversion happens once, at the provider
 * boundary. Every stamp on these link docs is ms (root `CLAUDE.md` rule 7's
 * cross-unit trap).
 *
 * ⚠️ `days_to_fix` is LEGACY — a DURATION in days from the retired code-6
 * payload, kept nullable because the migrated corpus holds it. It is **never
 * derived** from `fix_deadline_time`, and `fix_deadline_time` is never derived
 * from it: the conversion needs a clock, loses the original value and is not
 * idempotent. A modern row leaves it `null`; a legacy row leaves the four
 * modern keys `null`. Both parse.
 *
 * `.passthrough()` for the same reason as everything else in this file: an
 * unenumerated key Shopee adds survives the round trip instead of being dropped.
 */
export const shopeeViolacaoSchema = z
  .object({
    violation_type: z.string().nullable().default(null),
    violation_reason: z.string().nullable().default(null),
    suggestion: z.string().nullable().default(null),
    /** MILLISECONDS (the wire sends seconds). When the seller must have fixed it. */
    fix_deadline_time: z.number().int().nullable().default(null),
    /** MILLISECONDS (the wire sends seconds). PER DETAIL on push 18, not on the envelope. */
    update_time: z.number().int().nullable().default(null),
    /** Deboost side only — the one actionable field the legacy shape had no home for. */
    suggested_category: z
      .array(
        z
          .object({
            category_id: z.number().int().nullable().default(null),
            category_name: z.string().nullable().default(null),
          })
          .passthrough(),
      )
      .nullable()
      .default(null),
    /** Which of push 18's two detail arrays this row came from. `null` on a legacy row. */
    kind: z.enum(['status', 'deboost']).nullable().default(null),
    /** LEGACY (retired code 6), a DURATION in days. Never derived — see the docblock. */
    days_to_fix: z.number().int().nullable().default(null),
  })
  .passthrough();
export type ShopeeViolacao = z.infer<typeof shopeeViolacaoSchema>;

/**
 * One banned-item violation reason (`ReasonListBannedItemPush`, #363).
 *
 * @deprecated the pre-#1519 element of `violations`, superseded by
 * {@link shopeeViolacaoSchema} (which parses every document this one parsed —
 * the four keys are a subset). Kept exported for one release so nothing outside
 * this file breaks on the rename; delete it after that.
 */
export const shopeeViolationReasonWireSchema = z
  .object({
    days_to_fix: z.number().int().nullable().default(null),
    suggestion: z.string().nullable().default(null),
    violation_reason: z.string().nullable().default(null),
    violation_type: z.string().nullable().default(null),
  })
  .passthrough();
/** @deprecated see {@link shopeeViolationReasonWireSchema}. */
export type ShopeeViolationReasonWire = z.infer<typeof shopeeViolationReasonWireSchema>;

/** `produtos/{id}/prodshopee/{docId}` — the Shopee listing link doc. */
export const produtoShopeeLinkSchema = z
  .object({
    // Required account link — the `(contaProdutoShopeeOuterRef, sku)` lookup
    // key of the #363 notification processors (legacy required ctor param).
    // ⚠️ Neither schema in this file DECLARES `sku`, so that sentence names
    // half a key this repo cannot write typed; step 9's import writes no `sku`
    // on either link doc rather than persist an untyped one through
    // `.passthrough()`. Recorded as a follow-up, not fixed here.
    contaProdutoShopeeOuterRef: outerRefSchema,
    item_name: z.string().min(1),
    item_id: z.number().int().nullable().default(null),
    category_id: z.number().int().nullable().default(null),
    description: z.string().nullable().default(null),
    description_type: z.string().nullable().default(null),
    // Rich-description blob (paragraphs/images) — not fully enumerated by the audit.
    description_info: z.record(z.string(), z.unknown()).nullable().default(null),
    attributes: z.array(z.unknown()).nullable().default(null),
    complaint_policy: z.record(z.string(), z.unknown()).nullable().default(null),
    pre_order: z.record(z.string(), z.unknown()).nullable().default(null),
    item_status: shopeeItemStatusSchema.nullable().default(null),
    logistic_info: z.array(z.unknown()).nullable().default(null),
    wholesale: z.array(z.unknown()).nullable().default(null),
    brand_id: z.number().int().nullable().default(null),
    item_dangerous: z.number().int().nullable().default(null),
    /**
     * What Shopee says is wrong with this listing — Flutter writes this even
     * when null (`errors`-style).
     *
     * ⚠️ The ELEMENT was widened by #1519 from the retired code-6
     * `ReasonListBannedItemPush` shape to {@link shopeeViolacaoSchema}. It is
     * not a breaking change: every legacy key survives as a nullable member, so
     * a migrated row still parses and reads exactly as before.
     */
    violations: z.array(shopeeViolacaoSchema).nullable().default(null),

    // === step 11 (#1519) — the listing LIFECYCLE, none of it a Shopee wire field
    // except `condition`. Every one is `.nullable().default(null)` (or
    // `.default([])`) so a link doc step 9 imported keeps parsing and a `merge`
    // that does not name a field leaves it alone.

    /**
     * The folded state of this listing — {@link estadoAnuncioShopeeSchema}.
     * `null` means NEVER FOLDED (a step-9 link), which is not evidence of
     * anything and is deliberately treated as movable/live, never as dead.
     * Written by all four `item_status` writers, from the same read.
     */
    estadoAnuncio: estadoAnuncioShopeeSchema.nullable().default(null),
    /**
     * Shopee has demoted this listing in search. ORTHOGONAL to `estadoAnuncio`:
     * a deboosted listing is still `ativo`. `null` = never read.
     */
    deboost: z.boolean().nullable().default(null),
    /**
     * The ERP's OWN intent, written by the pause/re-list path and by nothing
     * else. ⚠️ It is the only thing that separates a seller pause from a Shopee
     * pre-launch hold: both are `UNLIST` on the wire and are otherwise
     * indistinguishable. It moves only on a SUCCESS — a skipped or failed
     * entry leaves the stored intent alone.
     */
    pausadoPeloErp: z.boolean().nullable().default(null),
    /**
     * `NEW` / `USED` — the last value the publisher SENT (`announcement 1528`
     * makes it mandatory on create and update alike, so the publisher has to
     * know what it last sent).
     *
     * ⚠️ A loose string, not an enum, for {@link shopeeItemStatusSchema}'s
     * reason: a response vocabulary Shopee widens must cost one field, never a
     * page.
     */
    condition: z.string().nullable().default(null),
    /** The brand name Shopee reports for `brand_id` — written by the publish read-back. */
    original_brand_name: z.string().nullable().default(null),
    /** MILLISECONDS. The FIRST successful publish only — never rewritten by a republish. */
    publicadoEm: z.number().int().nullable().default(null),
    /**
     * The last publish that SUCCEEDED, for the operator's audit trail.
     *
     * ⚠️ NESTED ⇒ it can only be written through `merge`/`add`, never through
     * `mergeIfExists` (which rejects a nested object). That is why the publish
     * write-backs and the lifecycle write-backs use two different mechanisms.
     */
    ultimaPublicacao: z
      .object({
        /** MILLISECONDS. */
        em: z.number().int(),
        etapa: z.string(),
        itemId: z.number().int().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    /**
     * The last publish that FAILED, with the classified problemas the operator
     * can act on. Same nesting rule as {@link ultimaPublicacao}: `merge` only.
     *
     * `motivo` and `etapa` are loose strings here on purpose — the closed
     * vocabularies live beside the publisher (`anuncios/errosPublicacao.ts`),
     * and a slug added there must not need a schema change to be persisted.
     */
    falhaPublicacao: z
      .object({
        /** MILLISECONDS. */
        em: z.number().int(),
        etapa: z.string(),
        erro: z.string(),
        mensagem: z.string(),
        problemas: z
          .array(
            z
              .object({
                campo: z.string(),
                motivo: z.string(),
                mensagem: z.string(),
              })
              .passthrough(),
          )
          .default([]),
      })
      .passthrough()
      .nullable()
      .default(null),
    /**
     * Why the `tax_info` block was omitted from the last publish, or `null` when
     * it was sent whole. A `MotivoTaxInfoOmitido` slug — a loose string for the
     * same reason `falhaPublicacao.motivo` is. ⚠️ Shopee's BR tax block is
     * all-or-nothing, so a partial one is never sent.
     */
    taxInfoOmitido: z.string().nullable().default(null),
    /**
     * MILLISECONDS. When the stored `violations` list last CHANGED — written by
     * the re-verify and by push 16, and by both under the same rule.
     *
     * ⚠️ **An identical reading does NOT move it.** The two writers compare the
     * list they are about to store against the stored one (`mesmasViolacoes`, one
     * comparison shared by both) and stamp only on a difference, so the field
     * answers "since when has this been the picture", never "when did we last
     * look". That is what keeps the re-verify's `ignorado-sem-mudanca` reachable
     * and what stops a healthy button press writing a document per press.
     */
    violacoesLidasEm: z.number().int().nullable().default(null),
    /**
     * MILLISECONDS. When a SCHEDULED publish was **reported** as failed — the
     * instant push 27 was processed, never the `scheduled_publish_time` the
     * publish was due at.
     * ⚠️ The push carries no reason and there is no success push, so this stamp
     * says only *that* it failed — never why, and never when it was meant to run.
     */
    agendamentoFalhouEm: z.number().int().nullable().default(null),

    // === step 12 (#1520) — the STOCK SYNC's write-backs: ten `estoque*`
    // scalars plus one schema flag. Same rule as the step-11 block above — bare
    // consts on this `.passthrough()` shape ⇒ no ruleset regeneration — and the
    // same nullable/default discipline, so a link step 9 imported keeps parsing
    // and a merge that does not name a field leaves it alone.
    //
    // ⚠️ FLAT is not a style choice. The sender writes through the handle's
    // `mergeIfExists`, which rejects a nested object or a dotted key outright,
    // so a tidier `ultimoEnvioDeEstoque { … }` block is INEXPRESSIBLE on that
    // path — the identical constraint that keeps {@link ultimaPublicacao} off
    // it. Ten flat scalars is the cost of writing through a handle that refuses
    // to resurrect a link doc someone deleted while the task sat in the queue.
    //
    // ⚠️ Every stamp below is MILLISECONDS.

    /**
     * Whether SHOPEE reports this listing as a kit item (`tag.kit` on
     * `get_item_base_info` / `get_item_list`).
     *
     * ⚠️ **This is NOT `produto.ehKit`.** The ERP has thousands of `ehKit`
     * produtos that are ORDINARY Shopee listings and whose stock is sent at the
     * component-derived quantity; conflating the two is a total, silent stock
     * outage for the whole legacy kit catalogue.
     *
     * Stamped on BOTH branches by step 9's import (`true` for a kit, `false`
     * for an ordinary listing) from `ehKitDe()` (`produtos/itemLido.ts`), which
     * already computes it and throws it away — so the field converges to DATA on
     * every import rather than staying three-valued for ever.
     *
     * `null` = a link imported before step 12 — **it SENDS**, which is the safe
     * direction, because no native Shopee kit exists in this catalogue today.
     * Only `kitNativo === true` refuses.
     */
    kitNativo: z.boolean().nullable().default(null),
    /**
     * MILLISECONDS. The last time this listing was **FULLY** in sync — written
     * by a CLEAN send and by nothing else.
     *
     * ⚠️ A PARTIAL send deliberately leaves it alone: "fully in sync" is the
     * operator's real question, and it is also the anchor a child row's
     * visibility is compared against (a per-model refusal is legible exactly
     * while the child's `estoqueRecusaEm` is at least this value, which makes
     * the child rows self-expiring and costs no second writer).
     */
    estoqueEnviadoEm: z.number().int().nullable().default(null),
    /**
     * The quantity SENT for the no-model listing, or the **SUM** sent across
     * the accepted models — never a maximum, and never the echo Shopee sends
     * back. A twenty-model family at 5 each stores 100.
     */
    estoqueEnviado: z.number().int().nullable().default(null),
    /** How many models the last `update_stock` call carried. */
    estoqueModelosEnviados: z.number().int().nullable().default(null),
    /** MILLISECONDS. When the last refusal landed — including a partial one. */
    estoqueRecusaEm: z.number().int().nullable().default(null),
    /**
     * Shopee's error code **VERBATIM, prefix and all**, or `erp:<motivo>` when
     * the refusal is ours rather than Shopee's.
     *
     * ⚠️ Stored unstripped on purpose. The prefix is part of what Shopee
     * answered, and a code rewritten at the write side can never be matched back
     * against the provider's own documentation; the stripped form is a second
     * LOOKUP beside the verbatim one, never a replacement for it.
     */
    estoqueRecusaCodigo: z.string().nullable().default(null),
    /**
     * Why the send was refused, in this app's own vocabulary — a
     * `MotivoEstoqueShopee` slug.
     *
     * ⚠️ A loose string, not an enum, for the reason
     * {@link produtoShopeeLinkSchema}'s `falhaPublicacao.motivo` is one: the
     * closed vocabulary lives beside the sender that writes it, and a slug added
     * there must not need a schema change to be persisted.
     */
    estoqueRecusaMotivo: z.string().nullable().default(null),
    /** The rendered pt-BR sentence for the operator, capped at the publisher's problem-message length. */
    estoqueRecusaMensagem: z.string().nullable().default(null),
    /**
     * The folded `estadoAnuncio` **at refusal time** — half of the refusal
     * fingerprint, and the field that documents the whole skip set.
     *
     * The stock gate skips this listing when EITHER mechanism says so:
     *
     * ```
     * ouNulo(v) = v === undefined ? null : v   // the ONE normalisation, BOTH sides
     *
     * // TIME half
     * pular = (typeof estoqueRecusaAte === 'number' && nowMs < estoqueRecusaAte)
     * // STATE half
     *      || (typeof estoqueRecusaEm === 'number'
     *          && (ouNulo(estoqueRecusaEstado) !== null
     *              || ouNulo(estoqueRecusaItemStatus) !== null)   // ≥ 1 RECORDED reading
     *          && ouNulo(estoqueRecusaEstado)     === ouNulo(link.estadoAnuncio)
     *          && ouNulo(estoqueRecusaItemStatus) === ouNulo(link.item_status))
     * ```
     *
     * ⚠️ The at-least-one-recorded-reading guard exists because
     * `estoqueRecusaEm` is also stamped by a PARTIAL send, which records no
     * reading at all: without it a null/null stamp on a link whose two readings
     * are null or absent compares `null === null` twice (after the fold) and
     * latches the listing FOR EVER, since neither half can ever move to lift it.
     *
     * ⚠️ `pularPorRecusaAnterior` in `apps/shopee/lib/shopee/estoque/podeEnviarEstoque.ts`
     * is the implementation this block DESCRIBES — never the other way round. When
     * the two disagree, the code is the rule and this text is the defect.
     *
     * ⚠️ `||` between the two mechanisms, **`&&` between the two fingerprint
     * halves — either one moving LIFTS the skip.** That is the whole design:
     * **nobody writes a clear to lift it.** The four `item_status` writers
     * enumerated on {@link shopeeItemStatusSchema} lift it by doing their job, so
     * the refusal expires against the reading that caused it instead of against a
     * clock or a second writer that could disagree. The stock sender's clean-send
     * write-back (`registrarEnvioLimpo`, `apps/shopee/lib/shopee/estoque/linkEstoque.ts`)
     * does null every `estoqueRecusa*` field, but only after a send has already
     * happened. When the skip had lifted and let that send through, the clear
     * follows the lift. When the manual push's `reenviarComErro` bypassed a skip
     * that was still armed, the clear is what disarms it — and only after that
     * operator-forced send succeeded. Either way it is the one clear, and nothing
     * ever writes it IN ORDER to lift a skip.
     *
     * ⚠️ The rule is READ by the app (`podeEnviarEstoqueShopee`) and is **never
     * computed in this schema** — it needs a clock, and every schema in this file
     * is pure.
     *
     * A loose string rather than {@link estadoAnuncioShopeeSchema} on purpose:
     * it is a recorded READING to compare against, not a state to act on, and a
     * stored value this app later stops recognising must still compare equal to
     * itself.
     */
    estoqueRecusaEstado: z.string().nullable().default(null),
    /** The raw `item_status` at refusal time — the other fingerprint half. Loose for the same reason. */
    estoqueRecusaItemStatus: z.string().nullable().default(null),
    /**
     * MILLISECONDS. The TIME half of the skip set: skip until this instant.
     *
     * ⚠️ Written only by the promotion arm, and it exists because **a promotion
     * ending moves no `item_status`** — a fingerprint-based skip would latch for
     * ever on a listing whose reserved stock simply expired. Strictly `<`
     * against the clock, so the instant itself already releases.
     */
    estoqueRecusaAte: z.number().int().nullable().default(null),
  })
  .passthrough();
export type ProdutoShopeeLink = z.infer<typeof produtoShopeeLinkSchema>;

/** `produtos/{childId}/variashopee/{docId}` — a variation link doc. */
export const variacaoShopeeLinkSchema = z
  .object({
    // Required links back to the owning account and the parent listing doc
    // (legacy required ctor params).
    contaVariacaoShopeeOuterRef: outerRefSchema,
    produtoShopeeOuterRef: outerRefSchema,
    model_id: z.number().int(),
    tier_index: z.array(z.number().int()).default([]),
    promotion_id: z.number().int().nullable().default(null),
    model_status: shopeeModelStatusSchema.nullable().default(null),
    /**
     * MILLISECONDS — step 11 (#1519). When a `get_model_list` read stopped
     * reporting this `model_id`.
     *
     * ⚠️ MARK, never delete. It is written beside
     * `model_status: 'MODEL_UNAVAILABLE'` and the child link doc STAYS: the ML
     * precedent (`variacoesFantasma.ts`) is that a stale id is marked so an
     * operator can see it, because a delete throws away the only record that the
     * ERP ever bound this variação to that model. A model that comes back simply
     * clears the stamp.
     */
    modeloAusenteEm: z.number().int().nullable().default(null),

    // === step 12 (#1520) — two DIAGNOSTIC fields, never a gate.
    //
    // A refusal is per MODEL, and without a per-model row an operator sees "the
    // item was refused" with no way to know which of up to fifty models caused
    // it. Nothing reads them to decide whether to send.
    //
    // ⚠️ **ZERO clearing writes.** Clearing on success would cost one update per
    // model per send, on every listing, several times an hour. Instead the row
    // SELF-EXPIRES by comparison: a reader shows it only while
    // `estoqueRecusaEm >= (parent.estoqueEnviadoEm ?? 0)`. Because a PARTIAL
    // send never stamps the parent's `estoqueEnviadoEm`, a current diagnosis
    // stays visible and a stale one vanishes the moment the item next syncs
    // cleanly — at the cost of no second writer at all.

    /** MILLISECONDS. When this MODEL was refused. Written only on a per-model refusal. */
    estoqueRecusaEm: z.number().int().nullable().default(null),
    /**
     * The model's own `failed_reason`, **VERBATIM** — Shopee's string exactly as
     * it arrived, prefix and all, for the same reason the parent's
     * `estoqueRecusaCodigo` is stored unstripped.
     */
    estoqueRecusaCodigo: z.string().nullable().default(null),
  })
  .passthrough();
export type VariacaoShopeeLink = z.infer<typeof variacaoShopeeLinkSchema>;

/** Why a stored Shopee link cannot be moved to the requested status right now. */
export type MotivoAnuncioNaoMovivel =
  | 'sem-item-id'
  | 'anuncio-removido'
  | 'anuncio-banido'
  | 'anuncio-em-revisao'
  | 'anuncio-agendado'
  | 'ja-pausado'
  | 'ja-ativo';

/**
 * Can this stored Shopee link be moved to `acao` right now? (#1519, step 11.)
 *
 * ⚠️ **Pure and total — no clock, no network, no Firestore**, which is the whole
 * reason it lives here rather than in whichever surface needed it first. Two
 * surfaces ask the identical question and must never disagree:
 *
 *  - **Client** (`apps/web`, step 21) — whether the produto's Shopee tab renders
 *    "Pausar anúncio", "Reativar anúncio", or no control at all;
 *  - **Server** (`apps/shopee`) — whether `pausarAnuncio.ts` puts the id into
 *    the `unlist_item` batch or skips it before any Shopee call.
 *
 * A second copy would be the failure `precisaConsultarModeracao` (#1239) and
 * `clienteIdentity` (#786) were extracted to avoid: an operator offered a button
 * the backend refuses, or a backend refusing what the UI presents as available.
 * {@link AcaoStatusAnuncio} is REUSED from the ML link module for the same
 * reason — the file name is ML-ish, the VALUE must not fork.
 *
 * ⚠️ **Not to be reused for stock.** Step 12's `podeEnviarEstoqueShopee`
 * (`apps/shopee/lib/shopee/estoque/`) answers a DIFFERENT question — "may we
 * write a QUANTITY" rather than "may we change this listing's STATUS" — and
 * deliberately diverges: `banido` refuses in both, but `pausado` refuses here
 * (`ja-pausado`) and **SENDS** there, because an unlisted listing carries no
 * stock refusal and a stale number oversells the moment it is re-listed. The two
 * folds live apart on purpose; neither is the other's shortcut.
 *
 * ⚠️ **This is a cheap pre-filter on a possibly-stale reading, never the guard.**
 * Shopee's own `failure_list` is the authority and it refuses things this
 * function cannot see: roughly half the promotion types lock an unlist, and an
 * UPCOMING promotion locks as hard as a running one while
 * `get_item_base_info.has_promotion` reports only ongoing ones. So the answer
 * `{pode: true}` means "worth asking Shopee", never "Shopee will accept it".
 *
 * The rungs, in order:
 *
 *  - **Never published** (`item_id` absent, or not a positive integer) →
 *    `sem-item-id`. There is no listing to address.
 *  - **`removido`** → `anuncio-removido`. `guide 221 §6`: after the deletion the
 *    product can no longer be updated. Terminal.
 *  - **`banido`** / **`em_revisao`** → `anuncio-banido` / `anuncio-em-revisao`,
 *    both from `error_busi_cannot_delist_reviewing_or_banned_item` ("Banned and
 *    Reviewing Products cannot be delisted"). Two motivos rather than one so the
 *    operator message can name the actual cause.
 *  - **`reativar` on `agendado`** → `anuncio-agendado`. Re-listing now would
 *    cancel a schedule the operator deliberately set. ⚠️ `pausar` on `agendado`
 *    is deliberately ALLOWED — it is the operator cancelling that schedule, and
 *    no documented error refuses it. Over-allowing costs one refused call;
 *    over-refusing costs a control that cannot be pressed.
 *  - **The no-ops** → `ja-pausado` (`pausar` on `pausado`) and `ja-ativo`
 *    (`reativar` on `ativo`).
 *  - ⚠️ **`estadoAnuncio === null`** → `{pode: true}`. A link step 9 imported was
 *    never folded, and a missing reading is not evidence of anything; refusing it
 *    would make the control dead for the entire imported corpus. `desconhecido`
 *    passes for the same reason.
 */
export function podeMoverAnuncioShopee(
  link: { item_id: number | null; estadoAnuncio: EstadoAnuncioShopee | null },
  acao: AcaoStatusAnuncio,
): { pode: true } | { pode: false; motivo: MotivoAnuncioNaoMovivel } {
  const itemId = link.item_id;
  if (typeof itemId !== 'number' || !Number.isFinite(itemId) || itemId <= 0) {
    return { pode: false, motivo: 'sem-item-id' };
  }
  const estado = link.estadoAnuncio;
  if (estado === ESTADO_ANUNCIO_SHOPEE.removido) {
    return { pode: false, motivo: 'anuncio-removido' };
  }
  if (estado === ESTADO_ANUNCIO_SHOPEE.banido) {
    return { pode: false, motivo: 'anuncio-banido' };
  }
  if (estado === ESTADO_ANUNCIO_SHOPEE.emRevisao) {
    return { pode: false, motivo: 'anuncio-em-revisao' };
  }
  if (acao === ACAO_STATUS_ANUNCIO.reativar) {
    if (estado === ESTADO_ANUNCIO_SHOPEE.agendado) {
      return { pode: false, motivo: 'anuncio-agendado' };
    }
    if (estado === ESTADO_ANUNCIO_SHOPEE.ativo) {
      return { pode: false, motivo: 'ja-ativo' };
    }
    return { pode: true };
  }
  if (estado === ESTADO_ANUNCIO_SHOPEE.pausado) {
    return { pode: false, motivo: 'ja-pausado' };
  }
  return { pode: true };
}
