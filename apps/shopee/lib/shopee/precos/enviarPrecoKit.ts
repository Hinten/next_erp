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
 * A planned model with no USABLE live model is NOT sent: it comes back in
 * `semModeloVivo`, and the sender records that row as
 * `forma-de-modelo-divergente`, stamped `erp:` (the remedy is a re-import).
 * That is a model the live kit does not carry, one it carries but this module
 * cannot resend verbatim (see Errors), and EVERY planned model when the read
 * answered another item. When none is usable, `update_kit_item` is not called
 * — the package refuses an empty `model_list`, and a call that changes nothing
 * spends quota. The same list reaches `aoSepararModelos` BEFORE the write, so
 * a caller whose `update_kit_item` is then REFUSED still knows which models
 * never went (the sender's row for them stays `forma-de-modelo-divergente`,
 * never Shopee's refusal of a call they were not in).
 *
 * ⚠️ The decision's PRICE is never judged here: the set-aside check runs with
 * the price left out, so a price the package refuses (more than two decimals,
 * …) is OUR bug, and it is thrown by the guard of the assembled body inside
 * `updateKitItem`, never turned into a row.
 *
 * ## Errors
 *
 * Nothing either CALL throws is caught here. A `product_info: null` answer is
 * thrown as the SAME `ShopeeApiError` the read of an unreadable kit carries (the
 * probe's literal `"."` code, `kind: other`) so the sender's ladder classifies
 * it exactly as it would that refusal.
 *
 * ⚠️ A live model that cannot be resent verbatim — no `tier_index` read, or one
 * the package's own resend refuses (a component `quantity` that did not read,
 * no component row, …) — is never guessed and never THROWN: it is set aside
 * into `semModeloVivo` like a model the kit lacks, and the usable models still
 * go. So is a read that answered another `item_id`. Each is a condition of ONE
 * listing's wire (the read tolerates all of them: `tier_index` and
 * `component_list` default to `[]`, `quantity` is nullable), and a
 * `ShopeeConfigError` — "our own misconfiguration" — would end the whole run in
 * the sender's callers: the job stamps it failed on attempt 0, the manual push
 * aborts its siblings. The unusable live models share ONE `console.warn`,
 * listing every such model with its cause — the package's sentence, or this
 * module's own for a missing `tier_index` (field paths, never a value); a read
 * of another item is ONE `console.warn` with both item ids.
 *
 * What no single model shows — two live models claiming one option, or a second
 * `main_component` — is still the package guard's refusal of the ASSEMBLED body
 * inside `updateKitItem`, and propagates: it names no one model to set aside.
 *
 * No clock, no Firestore, no `next/server`: the functions bundle reaches this
 * folder.
 */
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_GET_KIT_ITEM_INFO_PATH,
  ShopeeApiError,
  ShopeeConfigError,
  assertUpdateKitItemRequest,
  linhasDeReenvioDoKit,
  shopeeUpdatePricePayloadSchema,
  type ShopeeClient,
  type ShopeeKitModel,
  type ShopeeUpdateKitModelRequest,
  type ShopeeUpdatePrice,
} from '@delfrance/integrations-shopee';

/** The one log tag of this module. */
const TAG_LOG = '[shopee/precos] envio de preço de kit';

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

/** A live model's resend entry — everything but the price, which is the decision's. */
type ReenvioSemPreco = Required<
  Pick<ShopeeUpdateKitModelRequest, 'model_id' | 'tier_index' | 'component_list'>
>;

/** One live model set aside, and the sentence that says why (field paths, never a value). */
interface ModeloInutilizavel {
  readonly modelId: number;
  readonly causa: string;
}

/**
 * The live model as a resend entry WITHOUT the price — or WHY it cannot be
 * one, never a guess:
 *
 * - no `tier_index` read ⇒ no option to resend (an invented index could point
 *   a price at another option's model);
 * - the package's OWN resend refuses it: `linhasDeReenvioDoKit` (a component
 *   `quantity` that did not read), then `assertUpdateKitItemRequest` over this
 *   model ALONE, price omitted (no component row, a quantity under the bound,
 *   …) — the one copy of those rules, never a second one here.
 *
 * ⚠️ The ONE catch in this module, narrowed to `ShopeeConfigError`: every
 * input to it is the live read's own (the ids were matched against it), so a
 * refusal is a fact about ONE listing's wire, never our misconfiguration —
 * and the class would end the whole run in the sender's callers (the job
 * stamps it failed on attempt 0, the manual push aborts its siblings).
 */
function reenvioDoModeloVivo(
  itemId: number,
  modelo: ShopeeKitModel,
): { readonly reenvio: ReenvioSemPreco } | { readonly causa: string } {
  const opcao = modelo.tier_index[0];
  if (opcao === undefined) {
    return { causa: 'tier_index não veio na leitura — sem ele não há opção para reenviar.' };
  }
  try {
    const reenvio: ReenvioSemPreco = {
      model_id: modelo.model_id,
      tier_index: [opcao],
      component_list: linhasDeReenvioDoKit(modelo),
    };
    assertUpdateKitItemRequest({ item_id: itemId, item_setting: { model_list: [reenvio] } });
    return { reenvio };
  } catch (err) {
    if (err instanceof ShopeeConfigError) return { causa: err.message };
    throw err;
  }
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
 * @param aoSepararModelos called ONCE, after the read and BEFORE the write
 *   (or in its place, when nothing is usable), with `semModeloVivo` — so a
 *   caller whose `update_kit_item` then throws still knows which planned
 *   models never went. Not called when the read itself throws. Optional; a
 *   no-op by default.
 * @returns `resposta` — the SYNTHESISED answer for G10 (every model actually
 *   sent in `success_list` with `original_price: null`; `failure_list` empty) —
 *   and `semModeloVivo`, the planned model ids with no USABLE live model (the
 *   live kit lacks it, cannot resend it verbatim, or the read answered another
 *   item), in `priceList` order, none of which was sent — the SAME list
 *   `aoSepararModelos` received.
 * @throws the SAME instance for every error of the two calls; a
 *   `ShopeeApiError` (code `"."`) when the kit reads `product_info: null`.
 */
export async function enviarPrecoDeKit(
  client: ShopeeClient,
  itemId: number,
  priceList: readonly { model_id: number; original_price: number }[],
  aoChamarShopee: () => void = () => undefined,
  aoSepararModelos: (semModeloVivo: readonly number[]) => void = () => undefined,
): Promise<{ resposta: ShopeeUpdatePrice; semModeloVivo: readonly number[] }> {
  aoChamarShopee();
  const info = await client.getKitItemInfo({ itemId });
  const vivo = info.product_info;
  if (vivo === null) throw kitIlegivel(itemId);
  // A read that answered ANOTHER item carries no live model of THIS kit: every
  // planned model falls to `semModeloVivo` below, and nothing is written — a
  // price never goes to the kit of another read.
  const doKit = vivo.item_id === itemId;
  if (!doKit) {
    console.warn(`${TAG_LOG}: a leitura do kit devolveu outro item; nenhum preço vai`, {
      itemId,
      itemIdLido: vivo.item_id,
    });
  }

  // The live models by id; the FIRST entry of a repeated id speaks (the
  // decision's `indexarLeitura` rule).
  const vivos = new Map<number, ShopeeKitModel>();
  for (const modelo of doKit ? vivo.model_list : []) {
    if (!vivos.has(modelo.model_id)) vivos.set(modelo.model_id, modelo);
  }

  const modelList: ShopeeUpdateKitModelRequest[] = [];
  const semModeloVivo: number[] = [];
  const inutilizaveis: ModeloInutilizavel[] = [];
  for (const entrada of priceList) {
    const modelo = vivos.get(entrada.model_id);
    if (modelo === undefined) {
      semModeloVivo.push(entrada.model_id);
      continue;
    }
    const lido = reenvioDoModeloVivo(itemId, modelo);
    if ('causa' in lido) {
      semModeloVivo.push(entrada.model_id);
      inutilizaveis.push({ modelId: entrada.model_id, causa: lido.causa });
      continue;
    }
    modelList.push({
      model_id: lido.reenvio.model_id,
      tier_index: lido.reenvio.tier_index,
      original_price: entrada.original_price,
      component_list: lido.reenvio.component_list,
    });
  }
  if (inutilizaveis.length > 0) {
    console.warn(`${TAG_LOG}: modelo vivo do kit sem reenvio verbatim; ele não vai`, {
      itemId,
      modelos: inutilizaveis,
    });
  }
  aoSepararModelos(semModeloVivo);

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
