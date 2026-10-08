/**
 * **The kit price TRANSPORT** (step 19, #1527 — reconcile §2.8, L5): one
 * native-kit item's changed prices ⇒ ONE `get_kit_item_info` + ONE PARTIAL
 * `update_kit_item`.
 *
 * The sender (`./enviarPreco`) picks this module at G9 when the fresh base row
 * reads as a kit (`LeituraDePreco.kit`); everything around the write — the
 * read, the decision, the attribution, the verification, the write-backs and
 * the error ladder — stays the sender's, so a kit and an ordinary listing
 * differ in exactly ONE call site. ⚠️ TRANSPORT-ONLY on purpose (S3F-11): the
 * verdict on a kit error, `veredictoDoErroDeKit`, lives INSIDE the sender beside
 * the module-private ladder it falls through to, never here.
 *
 * ## Why `update_kit_item`, and why PARTIAL
 *
 * Lucas picked the kit endpoint (L5); `update_price` on a kit model also landed
 * on the SG sandbox and is recorded as the measured alternative (register 271).
 * Probe #2 measured `update_kit_item` PARTIAL: a body carrying ONLY the changed
 * models and NO tier list keeps every omitted model. So the body is exactly
 * `{ item_id, item_setting: { model_list } }`, one entry per CHANGED model —
 * the decision's diff, never the whole kit — each carrying:
 *
 * - `model_id` — the planner's, confirmed against the LIVE kit;
 * - `tier_index: [live.tier_index[0]]` — the live model's own option, read back,
 *   never re-derived from the ERP (the kit's ONE tier);
 * - `original_price` — the decision's target;
 * - `component_list: linhasDeReenvioDoKit(live)` — the live rows resent
 *   VERBATIM, hidden default model id included: the package's single wire→wire
 *   copy, never a re-encoding of the ERP's recipe.
 *
 * No other key, and never the tier list: an appended model is a republish's
 * business (`kits/`), and resending the tier would turn a price push into a
 * structural write.
 *
 * ⚠️ **Register 301 is open**: whether a partial body keeps the omitted ITEM
 * fields (`item_name`, the images, the description, the logistics). If it did
 * not, every kit price push would wipe them and this module would have to resend
 * them from the same `get_kit_item_info`. The sender's kit read-back is the
 * tripwire — it compares the name and the image count with G1's base row.
 *
 * ## What the answer means, and what it does not
 *
 * `update_kit_item` answers a BARE envelope: no list, no echo. And a 200 never
 * means "applied" (P2-c: a changed component quantity answered 200 and was
 * silently ignored). So the answer handed back for G10 is SYNTHESISED — every
 * sent model in `success_list` with `original_price: null`, an empty
 * `failure_list` — which says only "Shopee did not refuse the call", and the
 * sender verifies a kit by a fresh RE-READ (`'releitura'`), never by this echo:
 * a numberless echo would confirm anything.
 *
 * A planned model the live kit does not carry is NOT sent: it comes back in
 * `semModeloVivo`, and the sender records that row as
 * `forma-de-modelo-divergente` (the remedy is a re-import). When no planned
 * model is live at all, `update_kit_item` is not called — the package refuses an
 * empty `model_list`, and a call that changes nothing spends quota.
 *
 * ## Errors
 *
 * Nothing is caught here. A `product_info: null` answer is thrown as the SAME
 * `ShopeeApiError` the read of an unreadable kit carries (the probe's literal
 * `"."` code, `kind: other`) so the sender's ladder classifies it exactly as it
 * would that refusal; a live model with no readable option or quantity is
 * refused as our own `ShopeeConfigError` rather than guessed (the package's own
 * posture for a resend with nothing verbatim to send).
 *
 * No clock, no Firestore, no `next/server`: the functions bundle reaches this
 * folder.
 */
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_GET_KIT_ITEM_INFO_PATH,
  ShopeeApiError,
  ShopeeConfigError,
  linhasDeReenvioDoKit,
  shopeeUpdatePricePayloadSchema,
  type ShopeeClient,
  type ShopeeKitModel,
  type ShopeeUpdateKitModelRequest,
  type ShopeeUpdatePrice,
} from '@delfrance/integrations-shopee';

/**
 * The code an unreadable kit is refused under — the measured `get_kit_item_info`
 * answer for an item that is not a readable kit (CAPTURE `rotas/07`).
 */
const CODIGO_KIT_ILEGIVEL = '.';

/** The live kit had no `product_info`: refused as the read of an unreadable kit is. */
function kitIlegivel(itemId: number): ShopeeApiError {
  return new ShopeeApiError(
    `Shopee ${SHOPEE_GET_KIT_ITEM_INFO_PATH} respondeu sem product_info para o kit ${String(itemId)}.`,
    {
      code: CODIGO_KIT_ILEGIVEL,
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: SHOPEE_GET_KIT_ITEM_INFO_PATH,
    },
  );
}

/**
 * The live model's option — `tier_index[0]` as read. ⚠️ Refused, never
 * guessed, when it did not read: an invented index could point a price at
 * another option's model.
 */
function opcaoDoModeloVivo(itemId: number, modelo: ShopeeKitModel): number {
  const indice = modelo.tier_index[0];
  if (indice === undefined) {
    throw new ShopeeConfigError(
      `enviarPrecoDeKit: o modelo ${String(modelo.model_id)} do kit ${String(itemId)} veio sem ` +
        'tier_index na leitura — sem ele não há opção para reenviar.',
    );
  }
  return indice;
}

/**
 * Send ONE native kit's changed prices.
 *
 * @param priceList the decision's body — only the CHANGED models, each at its
 *   target price (`decidirEnvioDePreco`'s `priceList`, the same list an ordinary
 *   item sends through `update_price`).
 * @param aoChamarShopee called once BEFORE each Shopee call this function
 *   issues, so the sender counts a call that then throws (its `chamadasShopee`
 *   rule for the `update_price` it replaces). Optional; a no-op by default.
 * @returns `resposta` — the SYNTHESISED answer for G10 (every model actually
 *   sent in `success_list` with `original_price: null`; `failure_list` empty) —
 *   and `semModeloVivo`, the planned model ids the live kit does not carry, in
 *   `priceList` order, none of which was sent.
 * @throws the SAME instance for every error of the two calls; a
 *   `ShopeeApiError` (code `"."`) when the kit reads `product_info: null`; a
 *   `ShopeeConfigError` when the read answers ANOTHER item, or a sent model's
 *   option or quantity did not read (`linhasDeReenvioDoKit`'s own refusal).
 */
export async function enviarPrecoDeKit(
  client: ShopeeClient,
  itemId: number,
  priceList: readonly { model_id: number; original_price: number }[],
  aoChamarShopee: () => void = () => undefined,
): Promise<{ resposta: ShopeeUpdatePrice; semModeloVivo: readonly number[] }> {
  aoChamarShopee();
  const info = await client.getKitItemInfo({ itemId });
  const vivo = info.product_info;
  if (vivo === null) throw kitIlegivel(itemId);
  if (vivo.item_id !== itemId) {
    throw new ShopeeConfigError(
      `enviarPrecoDeKit: a leitura do kit ${String(itemId)} devolveu o item ${String(vivo.item_id)} ` +
        '— um preço nunca vai para o kit de outra leitura.',
    );
  }

  // The live models by id; the FIRST entry of a repeated id speaks (the
  // decision's `indexarLeitura` rule).
  const vivos = new Map<number, ShopeeKitModel>();
  for (const modelo of vivo.model_list) {
    if (!vivos.has(modelo.model_id)) vivos.set(modelo.model_id, modelo);
  }

  const modelList: ShopeeUpdateKitModelRequest[] = [];
  const semModeloVivo: number[] = [];
  for (const entrada of priceList) {
    const modelo = vivos.get(entrada.model_id);
    if (modelo === undefined) {
      semModeloVivo.push(entrada.model_id);
      continue;
    }
    modelList.push({
      model_id: entrada.model_id,
      tier_index: [opcaoDoModeloVivo(itemId, modelo)],
      original_price: entrada.original_price,
      component_list: linhasDeReenvioDoKit(modelo),
    });
  }

  if (modelList.length > 0) {
    aoChamarShopee();
    await client.updateKitItem({ item_id: itemId, item_setting: { model_list: modelList } });
  }

  return {
    resposta: shopeeUpdatePricePayloadSchema.parse({
      success_list: modelList.map((m) => ({ model_id: m.model_id, original_price: null })),
      failure_list: [],
    }),
    semModeloVivo,
  };
}
