import { INTEGRACAO_TIPO, type IntegracaoTipo } from '../integracao';
import type { OrigemConversa } from '../conversa';

/**
 * Marketplace capability table — what replaced the `MarketplaceChannel` plugin
 * contract in #815. See ADR 0015 and the `marketplace-integration` skill.
 *
 * The contract it replaces declared ~25 members a channel "may" implement and
 * left every caller to feature-detect `typeof channel.pushPrice`. That answers
 * the wrong question twice over: it cannot be asked without holding a
 * server-side channel object (so `apps/web` can never ask it), and half of what
 * is worth knowing about a marketplace is not a function at all — whether it has
 * variations, whether it signs its webhooks, whether stock goes out one listing
 * at a time or as a batch.
 *
 * This is the `FREIGHT_TIPO_CAPS` shape (`./frete.ts`), which has thirteen
 * consuming files against that contract's one.
 */

/**
 * ⚠️ **Three-valued on purpose.** Four of the six rows below are channels nobody
 * has researched, and a `boolean` cannot say *"nobody has checked"* — it can only
 * say `false`, which reads as an answer. Putting an unverified claim into a type
 * is exactly the failure #815 exists to undo, so the honest default for an
 * unbuilt channel is `'desconhecido'`, and Phase 0 of the skill (read the
 * provider's documentation) is what converts it.
 *
 * Never guess `'sim'`/`'nao'` to make something compile. `'desconhecido'` exists
 * so you do not have to.
 */
export type Suporte = 'sim' | 'nao' | 'desconhecido';

/**
 * How a channel accepts a stock write. This is the axis on which Mercado Livre
 * is **least** representative, and it changes the whole downstream design:
 *
 * - `'por-anuncio'` — one call per listing (ML: `PUT /items/{id}`; two calls on a
 *   multiorigin conta). Drives one-task-one-write with the quantities baked into
 *   the task payload, and makes per-write cost the reason the sweep is tiered.
 * - `'lote'` — one call carrying up to `loteMax` SKUs, with a per-entry result
 *   array that must be unpacked to attribute a failure.
 * - `'feed-assincrono'` — submit a document, poll a result report later.
 *   ⚠️ NOT a variant of the other two: the notification pipeline's contract is
 *   "deterministic outcomes RETURN, transient failures THROW", and it has no
 *   state for *"submitted, result unknown"*. That protocol needs a submission
 *   record plus a poll sweep, which no channel here has written.
 */
export type EstoqueProtocolo =
  | 'por-anuncio'
  | 'lote'
  | 'feed-assincrono'
  | 'nenhum'
  | 'desconhecido';

export interface EstoqueCapabilities {
  readonly suporte: Suporte;
  readonly protocolo: EstoqueProtocolo;
  /** Max SKUs per call/feed. `null` when not applicable or not yet known. */
  readonly loteMax: number | null;
  /** Per-depósito / per-warehouse stock rather than one pooled quantity. */
  readonly multiDeposito: Suporte;
}

export interface MarketplaceCapabilities {
  /* ---- facts about THIS repo — exact, never 'desconhecido' ---- */
  /** Backend segment for `/api/marketplace/<channel>/*`, or `null` with no app. */
  readonly channel: string | null;
  /** Is there a deployed `apps/<channel>` backend today? */
  readonly implementado: boolean;

  /* ---- facts about the PROVIDER — tri-state ---- */
  readonly auth: 'oauth2' | 'api-key' | 'token-longo' | 'nenhuma' | 'desconhecido';
  /** PKCE (RFC 7636) — usually a per-registered-application toggle, not a global. */
  readonly pkce: Suporte;
  readonly notificacoes: 'push' | 'poll' | 'nenhuma' | 'desconhecido';
  /**
   * ⚠️ Does the provider SIGN its notifications? Mercado Livre does not — which
   * is why its receiver falls back to an `application_id` comparison that fails
   * OPEN. Every other channel here signs, and a signed channel must fail
   * **CLOSED** (secret unset ⇒ 503). Do not copy ML's receiver posture.
   */
  readonly assinaWebhook: Suporte;

  readonly publicarAnuncio: Suporte;
  readonly importarAnuncio: Suporte;
  readonly variacoes: Suporte;
  readonly categoriasEAtributos: Suporte;
  /** Size charts / grades — the ERP side is the `tabMedi` collection. */
  readonly tabelaDeMedidas: Suporte;
  /**
   * Native bundles whose stock the provider derives from the components.
   * ⚠️ ML is `'nao'`, and that is a **per-channel limitation, not a property of
   * virtual kits** — see `produto.ehKitVirtual`, whose docstring says so
   * outright, and #1087, the oversell that came from reading it the other way.
   */
  readonly kitVirtual: Suporte;
  /**
   * Can a live listing be PAUSED and put back on air, as opposed to only being
   * closed/deleted? A distinct question from {@link publicarAnuncio} — several
   * marketplaces expose only a terminal "close", and inferring pause from
   * publish is precisely the unverified claim #815 undid.
   */
  readonly pausarAnuncio: Suporte;

  readonly estoque: EstoqueCapabilities;
  readonly enviarPreco: Suporte;

  readonly importarPedido: Suporte;
  readonly importarPagamento: Suporte;
  /** Several orders consolidated into one shipment/pedido (ML packs). */
  readonly consolidaPacote: Suporte;
  /** The buyer's fiscal identity needs a second, gated call (not inline). */
  readonly dadosFiscaisSeparados: Suporte;

  /** `'fetch'` = the marketplace mints it and we download; `'emit'` = we mint it. */
  readonly etiqueta: 'fetch' | 'emit' | 'nenhuma' | 'desconhecido';
  readonly rastreio: 'push' | 'pull' | 'nenhuma' | 'desconhecido';
  readonly enviarNfe: Suporte;

  readonly perguntas: Suporte;
  readonly mensagensPosVenda: Suporte;
  readonly reclamacoes: Suporte;
  /** `OrigemConversa` values this channel writes into the unified inbox. */
  readonly origensConversa: readonly OrigemConversa[];
}

/**
 * The marketplace subset of `IntegracaoTipo`. `nenhuma`, `whatsapp` (messaging
 * only) and `balcao` (the physical counter) are not marketplaces and carry no
 * row.
 */
export type MarketplaceTipo = Exclude<
  IntegracaoTipo,
  typeof INTEGRACAO_TIPO.nenhuma | typeof INTEGRACAO_TIPO.whatsapp | typeof INTEGRACAO_TIPO.balcao
>;

/** Every capability field left `'desconhecido'` — the starting row for a channel. */
const NAO_INVESTIGADO = {
  auth: 'desconhecido',
  pkce: 'desconhecido',
  notificacoes: 'desconhecido',
  assinaWebhook: 'desconhecido',
  publicarAnuncio: 'desconhecido',
  importarAnuncio: 'desconhecido',
  variacoes: 'desconhecido',
  categoriasEAtributos: 'desconhecido',
  tabelaDeMedidas: 'desconhecido',
  kitVirtual: 'desconhecido',
  pausarAnuncio: 'desconhecido',
  estoque: {
    suporte: 'desconhecido',
    protocolo: 'desconhecido',
    loteMax: null,
    multiDeposito: 'desconhecido',
  },
  enviarPreco: 'desconhecido',
  importarPedido: 'desconhecido',
  importarPagamento: 'desconhecido',
  consolidaPacote: 'desconhecido',
  dadosFiscaisSeparados: 'desconhecido',
  etiqueta: 'desconhecido',
  rastreio: 'desconhecido',
  enviarNfe: 'desconhecido',
  perguntas: 'desconhecido',
  mensagensPosVenda: 'desconhecido',
  reclamacoes: 'desconhecido',
  origensConversa: [],
} as const satisfies Omit<MarketplaceCapabilities, 'channel' | 'implementado'>;

/**
 * Capability table keyed by every marketplace `IntegracaoTipo`. Because it is a
 * `Record<MarketplaceTipo, …>`, adding a marketplace tipo to
 * `integracaoTipoSchema` without a caps row is a **compile error** — the
 * structural guarantee the `marketplace-integration` skill checklist relies on.
 */
export const MARKETPLACE_TIPO_CAPS: Record<MarketplaceTipo, MarketplaceCapabilities> = {
  /**
   * The one implemented channel. Every value here is observed from the running
   * integration (`apps/mercado-livre`), not read off documentation.
   */
  [INTEGRACAO_TIPO.mercadoLivre]: {
    channel: 'mercado-livre',
    implementado: true,
    auth: 'oauth2',
    // Per-application DevCenter toggle, gated here behind
    // MERCADO_LIVRE_PKCE_ENABLED. ML's docs are explicit that once it is on the
    // parameters become MANDATORY, so the flag and the toggle flip together.
    pkce: 'sim',
    notificacoes: 'push',
    // Confirmed against live traffic 2026-08-19: no signature header of any
    // kind. The `ts=…,v1=…` scheme people find is Mercado Pago's, not ML's.
    assinaWebhook: 'nao',
    publicarAnuncio: 'sim',
    importarAnuncio: 'sim',
    variacoes: 'sim',
    categoriasEAtributos: 'sim',
    tabelaDeMedidas: 'sim',
    // ML Virtual Kits exist (`POST /items/kits`) but are User-Products-only,
    // immutable once published, and cannot represent a produto that HAS
    // variations — so this port never creates one. See `produto.ehKitVirtual`.
    kitVirtual: 'nao',
    // `PUT /items/{id}` with `status: 'paused' | 'active'`, shipped in #1412.
    pausarAnuncio: 'sim',
    estoque: {
      suporte: 'sim',
      // One `PUT /items/{id}` per listing; two calls on a multiorigin conta
      // (`GET /user-products/{id}/stock` for the x-version, then the warehouse PUT).
      protocolo: 'por-anuncio',
      loteMax: null,
      // `warehouse_management` contas, behind MERCADO_LIVRE_STOCK_MULTIORIGEM_ENABLED.
      multiDeposito: 'sim',
    },
    enviarPreco: 'sim',
    importarPedido: 'sim',
    importarPagamento: 'sim',
    consolidaPacote: 'sim',
    // `GET /orders/{id}/billing_info` is a separate call, and the order's own
    // buyer block can arrive masked.
    dadosFiscaisSeparados: 'sim',
    etiqueta: 'fetch',
    rastreio: 'push',
    enviarNfe: 'sim',
    perguntas: 'sim',
    mensagensPosVenda: 'sim',
    reclamacoes: 'sim',
    origensConversa: ['mlperg', 'mlped', 'mlclaims'],
  },

  /**
   * ⚠️ Everything below is UNBUILT — which is NOT the same as unresearched.
   * Shopee's row is a completed Phase 0 survey with `implementado: false`; the
   * other four are still all `'desconhecido'`. A `'desconhecido'` is not a gap
   * in this file — it is the honest state of the question, and Phase 0 of the
   * skill is what closes it. Only values with a citation are set.
   */
  /**
   * The Shopee Phase 0 survey (`.master_plans/shopee/shopee-marketplace-integration.md`
   * §1). Every field below is cited — `implementado` stays `false` until step 22
   * of that plan ships the App Hosting backend; `channel` is named now because
   * the backend segment is a fact about THIS repo's layout, not about Shopee.
   */
  [INTEGRACAO_TIPO.shopee]: {
    channel: 'shopee', // apps/shopee, :3009 (next free port)
    implementado: false,
    // Authorization-code-SHAPED, not RFC 6749: no client_secret (HMAC `sign` with
    // the partner_key instead), no scope (fixed by the immutable App Category),
    // no PKCE. guide 20, guide 16.
    auth: 'oauth2',
    pkce: 'nao', // no code_challenge anywhere in guide 20
    notificacoes: 'push', // + a pull backstop: v2.push.get_lost_push_message (3 days)
    // Authorization header = lowercase hex HMAC-SHA256(partner_key, callback_url +
    // "|" + raw_body). Fail CLOSED. guide 18.
    assinaWebhook: 'sim',
    publicarAnuncio: 'sim', // api v2.product.add_item / update_item
    importarAnuncio: 'sim', // get_item_list → get_item_base_info (50) → get_model_list (1/item)
    variacoes: 'sim', // ≤2 tiers, ≤50 models; standardise_tier_variation (guide 219, init_tier_variation)
    categoriasEAtributos: 'sim', // get_category / get_attribute_tree / get_brand_list / get_item_limit
    // READ + ATTACH only: get_size_chart_list/detail + size_chart_info.size_chart_id
    // on add/update_item. Authoring is Seller Centre only —
    // v2.product.update_size_chart no longer exists (survey C §6).
    tabelaDeMedidas: 'sim',
    // Native kit SKU: add_kit_item mints an item_id whose category/attributes/brand
    // sync from a main component; no stock field anywhere in the kit APIs
    // (derived). 1 tier, ≤9 kit variations, 2–10 components each
    // (get_kit_item_limit), composition frozen after create. survey C §7.
    kitVirtual: 'sim',
    // unlist_item {unlist:false} re-lists (guide 221 §6) — but its own error list
    // carries `error_set_normal_unlisted_item`. Step 11 MEASURED it live on the SG
    // SANDBOX shop, 2026-09-17: {unlist:false} re-listed a SELLER-created UNLIST
    // item (success_list: 1, no failures), so that is the first door and
    // `update_item {item_status: 'NORMAL'}` is the built fallback.
    // ⚠️ Only HALF settled. The Shopee PRE-LAUNCH UNLIST — the state that actually
    // answers `error_set_normal_unlisted_item` — cannot be produced on that shop,
    // and an SG sandbox answer is evidence about the API, never about BR.
    // `implementado` stays `false` until step 22 regardless.
    pausarAnuncio: 'sim',
    // Measured live on the SG SANDBOX shop, 2026-09-21, through the shipped step-12
    // package ops, with Lucas’s explicit go and a `delete_item` cleanup. Every
    // line names the probe that answers it; a line reading NAO MEDIDO says what is
    // still owed rather than keeping a guess.
    //   stock: 0 on UPDATE   — aceito                                          (P6)
    //   stock: 1 vs min_limit — NAO MEDIDO: the sandbox category declares no
    //     stock_limit at all (min_limit and max_limit both null), so the band
    //     could not be exercised; `bandaMax` is nullable in practice.          (P7)
    //   echo vs read-back    — iguais (but the read-back stays the authority:
    //     step 11 measured a STALE `update_item` echo)                         (P4)
    //   update_time moveu    — nao; faq 180 is right and the API page is wrong,
    //     so `get_item_list?update_time_from` detects no stock drift.          (P5)
    //   stock_list PARCIAL   — omitidos preservados (the #831 shape answered NO
    //     for stock), so one item’s models may be split across calls.          (P8)
    //   um modelo invalido   — so failure_list, on an HTTP 200 whose `error` is
    //     the EMPTY string: `error_busi_update_stock_failed` never fired, so the
    //     happy-path envelope is the primary attribution path.                 (P9)
    //   sem promocao         — an EMPTY `promotion` array. Which of the two
    //     declared `total_reserved_stock` positions is live stays UNVERIFIED — the
    //     sandbox carries no Discount module (guide 644).                      (P1)
    //   feriado PARCIAL      — nao bloqueia, so the `loja-em-ferias` conta gate is
    //     rightly FULL-only.                                                  (P10)
    //   feriado TOTAL        — NAO MEDIDO: a FULL holiday cannot be set over an
    //     active PARTIAL one (numeric refusal `10002`); transicao — NAO MEDIDO, and
    //     `error_holiday_mode_change_stock` has never been seen.              (P10)
    //   warehouse            — sem-multi-armazem, refused PREFIXED on the wire as
    //     `warehouse.error_not_in_whitelist`.                                  (P3)
    // ⚠️ An SG sandbox answer is evidence about the API, never about BR: the
    //    promotion regime, kits and multi-warehouse are not rehearsable there.
    // `implementado` stays `false` until step 22.
    estoque: {
      suporte: 'sim',
      // One item per call (api v2.product.update_stock); the item's models ride
      // in the same call with a per-model success_list/failure_list. Fan-out is
      // per LISTING, attribution per MODEL.
      protocolo: 'por-anuncio',
      loteMax: 50, // models per call, not items
      // location_id from get_warehouse_detail — a WHITELIST feature; the structure
      // is sticky. Probe P3 measured the refusal on the sandbox shop and it
      // arrives PREFIXED on the wire (`warehouse.error_not_in_whitelist`), which
      // is why every reader folds the module prefix on BOTH sides.
      multiDeposito: 'sim',
    },
    // Measured live on the SG SANDBOX shop, 2026-09-24, through the shipped step-13
    // `updatePrice` plus raw signed calls, with Lucas’s explicit go and a
    // `delete_item` cleanup of both throwaway UNLIST items. Same format as the
    // stock lines above: each names its probe, and NAO MEDIDO says what is owed.
    //   region / is_cb       — "SG" / false; the sandbox flag and the RESOLVED
    //     apiHost agree, which is what the region gate's one override keys on (P0)
    //   price_limit          — null: the sandbox category declares no band    (P1)
    //   original_price       — no zero-fill on a fresh item. ⚠️ has_promotion
    //     read TRUE on an item with no promotion at all: never a gate.        (P2)
    //   model_id sem modelo  — 0 and an omitted key both land, but the success
    //     entry carries NO model_id key at all (the schema reads it as null) (P4/P6)
    //   update_time moveu    — nao: it confirms no price write               (P5)
    //   terceira decimal     — arredondada half-up; the validator never sends one (P7)
    //   price_list PARCIAL   — the unsent sibling keeps its price, so the body
    //     carries only the models whose price changes                        (P8)
    //   um modelo invalido   — HTTP 200 with `error: ''` and BOTH lists       (P9)
    //   error + listas       — COEXIST (a bogus model on a no-model item), so
    //     updatePrice carries payloadNoErro                              (P4c-bogus)
    //   error_update_price_fail — Shopee's ONE answer, never transient, to a ratio
    //     breach (against an UNSENT sibling too: 4.5× aceito, 5.5× recusado on SG),
    //     a deleted item, a has-model item without a model and all-bogus models;
    //     `error_edit_item_price_for_item_has_model` never fired (P10/P11/P11b/P12/P15)
    //   promocoes, BRL, o 4× do BR, price_limit do BR, push 22 — NAO MEDIDO: an SG
    //     sandbox answer is evidence about the API, never about BR (no Discount
    //     module, no BR shop). MODEL_UNAVAILABLE — NAO MEDIDO (P14 not run).
    // update_price: one item, ≤ 50 models, 2 decimals. Locked by MOST promotion types
    // from SCHEDULED on (faq 140) — not wholesale, selling price, add-on main, PwP,
    // the gift. `implementado` stays `false` until step 22.
    enviarPreco: 'sim',
    importarPedido: 'sim',
    // No payment push, and no gateway-shaped payment resource — but a BR
    // per-order one DOES exist: get_order_detail.payment_info[] (per NT
    // 2025.001; provided "for orders with status READY_TO_SHIP", must be named
    // in response_optional_fields). pay_time/payment_method/total_amount are
    // OPTIONAL fields: an absent one means "not asked for", never "unpaid".
    // Fees = get_escrow_detail (floats, ONE order per call; the batch lacks
    // buyer_total_amount and has no per-order error, so it cannot replace it).
    // Settlement = get_escrow_list on escrow_release_time, page_no paging.
    // survey B §3.
    importarPagamento: 'sim',
    // One order → N packages (package_list). Many orders → one parcel exists only
    // as a read-only group_shipment_id with no seller action; split_order is not
    // a BR flow. survey B §10.
    consolidaPacote: 'nao',
    // Same call, but STATUS- and WHITELIST-gated: buyer name/address/CPF only
    // from INVOICE_PENDING onward and only for a CNPJ seller; masked values are
    // '***' STRINGS, not nulls; phone never. guide 382 / 743 / 718. The importer
    // must re-read after the gate opens.
    dadosFiscaisSeparados: 'sim',
    etiqueta: 'fetch', // Shopee mints; BR forbids self-design outright (guide 292)
    rastreio: 'push', // push 2 / 33 / 44 + pull get_tracking_info
    enviarNfe: 'sim', // upload_invoice_doc (XML, file_type 4, 1 MB), BEFORE ship_order, 5-min SERPRO delay
    perguntas: 'nao', // no public pre-sale Q&A surface; only private chat + post-purchase reviews
    // 12 v2.sellerchat.* APIs exist (docs login-gated) and webchat_push (code 10)
    // carries the message inline — but access is a per-app grant closed to ISVs
    // since 2024-11-18 (announcement 1026); BR Registered Business Sellers
    // request it via their Account Manager (1363/1430).
    // Decision 2026-09-03: the production app is an ERP System app, which
    // excludes the Chat API and the webchat push BY TYPE (guide 14, guide 18) —
    // unreachable from this app regardless of any grant. Revisit after the
    // cutover with a Seller In-house System app + the RM grant (step 16).
    mensagensPosVenda: 'nao',
    reclamacoes: 'sim', // v2.returns.* + push 32
    origensConversa: [], // filled by step 16 only if the chat grant lands
  },
  [INTEGRACAO_TIPO.amazon]: {
    ...NAO_INVESTIGADO,
    channel: null,
    implementado: false,
  },
  [INTEGRACAO_TIPO.magalu]: {
    ...NAO_INVESTIGADO,
    channel: null,
    implementado: false,
  },
  [INTEGRACAO_TIPO.lojaIntegrada]: {
    ...NAO_INVESTIGADO,
    channel: null,
    implementado: false,
  },
  /**
   * Facebook/Instagram is messaging-first (Shops catalog + Messenger + page
   * comments, #557) rather than an order marketplace, so several rows here may
   * settle on `'nao'` rather than on a capability. `origensConversa` is a fact
   * about OUR schema — both values already exist in `ORIGEM_CONVERSA`, inherited
   * from the legacy app — not a claim about Meta's API.
   */
  [INTEGRACAO_TIPO.facebook]: {
    ...NAO_INVESTIGADO,
    channel: null,
    implementado: false,
    origensConversa: ['facebook', 'comentario'],
  },
};

/** Capabilities for a marketplace tipo. */
export function marketplaceCapsFor(tipo: MarketplaceTipo): MarketplaceCapabilities {
  return MARKETPLACE_TIPO_CAPS[tipo];
}

/** Narrow an `IntegracaoTipo` to the marketplace subset. */
export function ehMarketplace(tipo: IntegracaoTipo): tipo is MarketplaceTipo {
  return (
    tipo !== INTEGRACAO_TIPO.nenhuma &&
    tipo !== INTEGRACAO_TIPO.whatsapp &&
    tipo !== INTEGRACAO_TIPO.balcao
  );
}

/**
 * Capabilities for any `IntegracaoTipo`, or `null` for a non-marketplace one.
 * The shape `apps/web` wants, where a tipo arrives off a stored document.
 *
 * ⚠️ Tolerant of a value outside the enum, like `freightCapsFor` (`./frete.ts`)
 * and for the same reason: Firestore documents reach the UI **unparsed**, and
 * the migrated legacy corpus carries wire-format enums this union does not
 * model. `ehMarketplace` only excludes the three known non-marketplace tipos,
 * so a stray value passes it and then indexes the `Record` to `undefined` —
 * which the return type would call a `MarketplaceCapabilities` and every caller
 * would dereference. Answering `null` routes it to the same "not a marketplace"
 * arm a caller already has to render.
 */
export function marketplaceCapsOrNull(tipo: IntegracaoTipo): MarketplaceCapabilities | null {
  if (!ehMarketplace(tipo)) return null;
  return MARKETPLACE_TIPO_CAPS[tipo] ?? null;
}
