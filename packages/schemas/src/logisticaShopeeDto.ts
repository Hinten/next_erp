import { z } from 'zod';

/**
 * The ENVELOPE of the Shopee CHANNELS route (#1911 P15) —
 * `GET /api/marketplace/shopee/canais?integracaoId&produtoId` in
 * `apps/shopee` — read by the draft's Logística editor in `apps/web` (P16).
 * One row per channel of the shop's `get_channel_list`, in that list's order,
 * each carrying the PUBLISHER's own verdict for that channel and that produto.
 *
 * ## Why here, and declared ONCE
 *
 * `apps/web` cannot import `apps/shopee`, so a browser reader of this answer
 * either shares the shape through this package or writes it twice, each copy
 * with a comment saying the names match the other — the #1369 shape: two copies
 * the compiler cannot compare, which drift toward plausible and read correct
 * while disagreeing. Both apps reach this package, so the route builds its 200
 * `satisfies z.input<typeof respostaCanaisShopeeSchema>`, its test parses that
 * 200 with the SAME schema object, and the browser imports that object instead
 * of mirroring it. Same move, same rules, as the size-chart and taxonomy
 * envelopes (`tabelaDeMedidasShopeeDto.ts`, `taxonomiaShopeeDto.ts`).
 *
 * The VERDICTS are not computed here: `selecionavel`, `obrigatorio`,
 * `indisponivel` and `automatica` come from `apps/shopee`'s
 * `avaliarCanaisDaLojaShopee` (`lib/shopee/anuncios/logisticaPublicacao.ts`),
 * the same per-channel decision a publish takes. This module only fixes the
 * shape they travel in, and it imports nothing but `zod`.
 *
 * ## Names
 *
 * This module follows `tabelaDeMedidasShopeeDto.ts`'s rule, not
 * `taxonomiaShopeeDto.ts`'s: a key the route INVENTS is pt-BR
 * (`medidasCompletas`, `canais`, `selecionavel`, `obrigatorio`, `indisponivel`,
 * `automatica`), and a field carrying a PROVIDER value is Shopee's own name in
 * camelCase (`logisticsChannelId`, `isFree`). Two provider values are the
 * deliberate exceptions, given pt-BR keys because they are what the editor
 * renders and decides with:
 * - `nome` — the editor's row label, Shopee's `logistics_channel_name`;
 * - `bloqueiaFreteGratisDoVendedor` — Shopee's
 *   `block_seller_cover_shipping_fee`, as a boolean.
 *
 * Both are a frozen seam P16 consumes; renaming either is a coordinated change
 * on both sides, never a tidy-up.
 *
 * ## Strict numbers, tolerant objects (deploy skew)
 *
 * `apps/web` and `apps/shopee` deploy separately, so the browser is routinely
 * one deploy OLDER or NEWER than the route answering it:
 * - every object is a plain `z.object` — an unknown key is STRIPPED, never a
 *   failure, so a newer route's extra field cannot cost an older browser;
 * - every key is REQUIRED — the route answers all of them on every 200, and a
 *   missing `selecionavel` read as "false" or `automatica` read as "none" would
 *   be a silent lie;
 * - every number is plain `z.number().int()`, never `wireInt()`: these describe
 *   OUR answer, whose provider ids already went through
 *   `@delfrance/integrations-shopee`'s tolerant wire readers, so a quoted number
 *   here is our own serialisation bug and must be loud. ⚠️ The residual of that
 *   strictness: the provider id arrives through `wireInt()`, which checks no
 *   sign, so one provider row with an id `<= 0` would make the browser refuse
 *   the WHOLE answer. Shopee never sends one.
 *
 * ## What is NOT here (Lucas, 11-04)
 *
 * No size, no fee and no `logistics_description` field: the editor offers no
 * size picker and no fee input. A `SIZE_SELECTION` or `CUSTOM_PRICE` channel —
 * which needs a value only Seller Centre defines — answers `indisponivel:
 * 'exige-valor-do-seller-centre'` instead, so the editor never offers a switch
 * the publisher would skip.
 *
 * Not a collection — no `registry.ts` entry, no ruleset.
 */

/* -------------------------------------------------------------------------- */
/*                       Why a channel is not available                        */
/* -------------------------------------------------------------------------- */

/**
 * The COARSE reason a SELECTABLE channel cannot take this produto, mapped from
 * the full pass's own per-channel decision:
 * - `nao-cabe` — the parcel is outside the channel's weight band, or over one
 *   of its axes or its axis sum;
 * - `limite-ilegivel` — the channel states its limits in a unit this app does
 *   not know, so the fit cannot be decided (never assumed `cm`);
 * - `exige-valor-do-seller-centre` — a `SIZE_SELECTION` or `CUSTOM_PRICE`
 *   channel: it needs a size or a fee only Seller Centre defines.
 *
 * A channel that is not selectable at all (`selecionavel: false`) answers
 * `null` here — `selecionavel` already says it.
 */
export const motivoIndisponivelCanalShopeeSchema = z.enum([
  'nao-cabe',
  'limite-ilegivel',
  'exige-valor-do-seller-centre',
]);
export type MotivoIndisponivelCanalShopee = z.infer<typeof motivoIndisponivelCanalShopeeSchema>;

/** The companion of {@link motivoIndisponivelCanalShopeeSchema} (`prefer-schema-enum`). */
export const MOTIVO_INDISPONIVEL_CANAL_SHOPEE = {
  naoCabe: 'nao-cabe',
  limiteIlegivel: 'limite-ilegivel',
  exigeValorDoSellerCentre: 'exige-valor-do-seller-centre',
} as const satisfies Record<string, MotivoIndisponivelCanalShopee>;

/* -------------------------------------------------------------------------- */
/*                              One channel, one row                           */
/* -------------------------------------------------------------------------- */

/** One channel of the shop, with the publisher's verdict for this produto. */
export const canalDaLojaShopeeDtoSchema = z.object({
  /** Shopee's `logistics_channel_id` — a positive integer; the editor keys its rows on it. */
  logisticsChannelId: z.number().int().positive(),
  /**
   * Shopee's `logistics_channel_name`, read the way every other surface of this
   * app reads it (`textoUtilizavelShopee`: trimmed, blank ⇒ `null`) — never
   * the read-back's `logistic_name`. `null` ⇒ the editor names the channel by
   * its id.
   */
  nome: z.string().nullable(),
  /**
   * Can a publish send this channel at all? Enabled at shop level (or
   * `force_enable`) AND not a fulfillment channel (`mask_channel_id` absent or
   * `0`) — the publisher's `canalSelecionavel`, never re-derived.
   */
  selecionavel: z.boolean(),
  /** A channel Shopee will not let the listing leave off — the publisher's `canalInescapavel`. */
  obrigatorio: z.boolean(),
  /**
   * Shopee's `block_seller_cover_shipping_fee === true`: the seller may not
   * cover this channel's shipping, so a free-shipping offer is masked to
   * `is_free: false` on it.
   */
  bloqueiaFreteGratisDoVendedor: z.boolean(),
  /** Why a selectable channel cannot take this produto, or `null` — see {@link motivoIndisponivelCanalShopeeSchema}. */
  indisponivel: motivoIndisponivelCanalShopeeSchema.nullable(),
  /**
   * The entry the FULL pass — «Automática», the publish with no stored list —
   * would send for this channel, or `null` when it would send none. `isFree`
   * is already masked by {@link bloqueiaFreteGratisDoVendedor}.
   */
  automatica: z.object({ isFree: z.boolean() }).nullable(),
});
export type CanalDaLojaShopeeDto = z.infer<typeof canalDaLojaShopeeDtoSchema>;

/* -------------------------------------------------------------------------- */
/*                                The envelope                                 */
/* -------------------------------------------------------------------------- */

/** `GET …/canais` — 200. */
export const respostaCanaisShopeeSchema = z.object({
  /**
   * `true` ⇒ the STORED produto has both a weight and the three dimensions, so
   * every fit verdict below was decided against them. `false` ⇒ at least one
   * is missing, and the editor says so before any channel verdict.
   */
  medidasCompletas: z.boolean(),
  /** One row per channel of `get_channel_list`, in that list's order. */
  canais: z.array(canalDaLojaShopeeDtoSchema),
});
export type RespostaCanaisShopee = z.infer<typeof respostaCanaisShopeeSchema>;
