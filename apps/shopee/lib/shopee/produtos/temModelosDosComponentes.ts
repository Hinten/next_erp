/**
 * Does each COMPONENT item of a Shopee native kit have variations? (#1527,
 * step 19, ruling R-d) — the ONE shared reader of the `has_model` authority the
 * component resolution needs, used by step 9's import (`lerAnuncio.ts`, the
 * mass-import kit drain) and by step 19's kit arms.
 *
 * ## Why the question exists at all
 *
 * `get_kit_item_info` answers a `component_model_id` for EVERY component row,
 * and for a component item with NO variations that id is Shopee's HIDDEN
 * default model id — NON-ZERO, not the `item_id`, and absent from that item's
 * own (empty) `get_model_list` (measured on the SG sandbox, step 19 probe #1).
 * So a non-zero id does not mean "a variation", and the only way to tell the
 * two apart is the component item's own `has_model`. The schemas package's
 * `modeloDoComponenteKit` turns `(modelId, has_model)` into the model the ERP
 * binds; this module only READS `has_model`.
 *
 * ## The contract
 *
 * - **Distinct, in chunks of at most `SHOPEE_ITEM_BASE_INFO_MAX_IDS` (50)**,
 *   one `get_item_base_info` per chunk, in first-seen order. Zero ids ⇒ zero
 *   calls. An id that is not a positive safe integer is never sent (the package
 *   would refuse the whole call before the fetch) and reads as unknown.
 * - **Reconciled by `item_id`, never by position.** A row that is absent, that
 *   the payload schema could not read (its `null` sentinel), or whose
 *   `has_model` is not a boolean, leaves its id ABSENT from the map — absent
 *   means UNKNOWN, never `false`. Reading an absent row as `false` would bind a
 *   component on its parent listing on no evidence (the import must fall back
 *   to the wire id and the SKU rungs instead). When two rows carry one id, the
 *   first one wins (`montarItemLido`'s rule).
 * - **A chunk answered with `error_item_not_found`** (either spelling, with or
 *   without the module prefix) is the batch verdict "none of these ids exists"
 *   — the call raises it only when EVERY id of the chunk is unknown — so the
 *   chunk contributes nothing and every one of its ids reads as unknown. Every
 *   other failure propagates untouched: a rate limit, a reauth or a network
 *   failure is not a property of this kit.
 * - **No cache.** A component that gains or loses its variations between two
 *   runs must be seen: the read is per import, per kit.
 */
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_ITEM_BASE_INFO_MAX_IDS,
  ShopeeApiError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  shopeeCodeSemPrefixoDeModulo,
  type ShopeeClient,
  type ShopeeKitItem,
} from '@delfrance/integrations-shopee';

/** The batch verdict "none of the ids of this call exists", compared on the STRIPPED code. */
const CODIGO_LOTE_DESCONHECIDO = 'error_item_not_found';

/**
 * Is `err` the batch verdict "none of these ids exists"? The two derived
 * classes are narrowed FIRST: both extend `ShopeeApiError`, and neither is ever
 * a verdict about the ids (the price sync's `leitorDeBase.ts` draws the same
 * line for the same call).
 */
function ehLoteDesconhecido(err: unknown): boolean {
  if (err instanceof ShopeeRateLimitError || err instanceof ShopeeReauthRequiredError) {
    return false;
  }
  if (!(err instanceof ShopeeApiError)) return false;
  if (err.kind !== SHOPEE_ERROR_KIND.other) return false;
  const codigo = shopeeCodeSemPrefixoDeModulo(err.code) ?? err.code;
  return codigo === CODIGO_LOTE_DESCONHECIDO;
}

function idUtilizavel(itemId: number): boolean {
  return Number.isSafeInteger(itemId) && itemId > 0;
}

/**
 * Every component `item_id` of a kit, across every model, in first-seen order
 * (duplicates included — {@link lerTemModelosDosComponentes} de-duplicates).
 */
export function itensDosComponentesDoKit(kit: ShopeeKitItem): number[] {
  return kit.model_list.flatMap((modelo) =>
    modelo.component_list.map((componente) => componente.component_item_id),
  );
}

/**
 * `item_id → has_model` for every component item Shopee answered with a
 * readable boolean. ABSENT key ⇒ unknown (see the module header).
 */
export async function lerTemModelosDosComponentes(
  client: ShopeeClient,
  itemIds: readonly number[],
): Promise<ReadonlyMap<number, boolean>> {
  const distintos = [...new Set(itemIds)].filter(idUtilizavel);
  const saida = new Map<number, boolean>();

  for (let inicio = 0; inicio < distintos.length; inicio += SHOPEE_ITEM_BASE_INFO_MAX_IDS) {
    const lote = distintos.slice(inicio, inicio + SHOPEE_ITEM_BASE_INFO_MAX_IDS);
    let payload: Awaited<ReturnType<ShopeeClient['getItemBaseInfo']>>;
    try {
      payload = await client.getItemBaseInfo({ itemIds: lote });
    } catch (err) {
      if (ehLoteDesconhecido(err)) continue;
      throw err;
    }
    const pendentes = new Set(lote);
    for (const linha of payload.item_list) {
      if (linha === null) continue;
      // `delete` answers whether the id was still pending: an id we did not
      // ask for, or a second row for one already seen, is skipped.
      if (!pendentes.delete(linha.item_id)) continue;
      if (typeof linha.has_model !== 'boolean') continue;
      saida.set(linha.item_id, linha.has_model);
    }
  }

  return saida;
}
