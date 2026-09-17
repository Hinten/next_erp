/**
 * Read ONE Shopee listing into the seam record every importer takes.
 *
 * The mass-import job pays for its reads in BATCHES (one
 * `get_item_base_info` for up to ten ids per dispatch); the single-item route
 * and the rehearsal CLI have exactly one id and no batch to amortise. This
 * module is that second path — and it ends on the SAME `montarItemLido` call
 * the job makes, so the three callers hand the importer an identical record.
 *
 * ## The three call patterns, and why a kit never asks for models
 *
 * 1. always ONE `get_item_base_info` for the single id;
 * 2. `tag.kit` ⇒ `get_kit_item_info`, and **nothing else**;
 * 3. otherwise `has_model === true` ⇒ `get_model_list`.
 *
 * A kit is routed through its own read because what `get_model_list` answers
 * for a kit listing is UNVERIFIED (the job's drain records the same reasoning
 * for `get_item_base_info`): asking anyway would spend a call on an unknown and
 * then plan variations out of whatever came back. A kit's components are the
 * kit page's answer, not the model page's.
 *
 * ## ⚠️ Reconciled by id, never by position
 *
 * `get_item_base_info` may answer with FEWER rows than were asked for — even
 * for one id. `montarItemLido` looks the row up by `item_id`; this module only
 * has to decide what an ABSENT row means, and for a single-id call the answer
 * is unambiguous: the listing is not there.
 */
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  type ShopeeClient,
  type ShopeeItemBaseInfo,
} from '@delfrance/integrations-shopee';

import { MOTIVO_IMPORT_BLOQUEADO, ShopeeImportBlockedError } from './errosImportacao';
import { ehKitDe, montarItemLido, temModelosDe, type ItemLido } from './itemLido';

/** Shopee's own code for "no such item", on the batch envelope. */
const CODIGO_ITEM_NAO_ENCONTRADO = 'error_item_not_found';

/**
 * The listing does not exist for this shop — Shopee refused the whole (one-id)
 * call.
 */
export const MSG_ITEM_NAO_ENCONTRADO =
  'A Shopee respondeu error_item_not_found para este item_id nesta loja.';

/**
 * The call succeeded and the item simply was not in it. Separate sentence from
 * {@link MSG_ITEM_NAO_ENCONTRADO} on purpose: one is a refusal, the other is an
 * empty answer, and only the second can also mean "the id belongs to another
 * shop this consent does not cover".
 */
export const MSG_ITEM_SEM_LINHA =
  'get_item_base_info respondeu sem nenhuma linha para este item_id — o anúncio não existe ' +
  'nesta loja ou não está visível para esta autorização.';

/**
 * `get_item_base_info` answered WITH a row for this id and the row did not
 * parse, so the payload schema's per-element sentinel dropped it.
 *
 * ⚠️ A separate sentence from {@link MSG_ITEM_SEM_LINHA} because the two say
 * OPPOSITE things about the shop: an empty list means the listing is not there
 * (or not visible to this authorisation), while a sentinel means it IS there and
 * its wire shape disagrees with a declared type. Mechanism only — the sentinel
 * keeps no field path and this sentence is published twice (a 422 body and
 * `failures[].mensagem`).
 */
export const MSG_ITEM_LINHA_ILEGIVEL =
  'get_item_base_info respondeu uma linha para este item_id que não pôde ser lida: ela não ' +
  'casa com o formato declarado e foi descartada pelo sentinela por-linha do payload.';

/** `get_kit_item_info` answered, and carried no kit. */
export const MSG_KIT_SEM_DETALHE = 'get_kit_item_info respondeu sem product_info para este kit.';

/**
 * One listing, READ — base info, then models OR the kit detail, never both.
 *
 * Throws {@link ShopeeImportBlockedError} for the two per-listing refusals this
 * read can decide on its own (`item-nao-encontrado`, `kit-sem-detalhe`), so a
 * route answers 422 naming the listing and the CLI prints `bloqueado: <motivo>`
 * and exits 0. Everything else — a rate limit, a reauth, a network failure, a
 * schema mismatch — propagates untouched: none of those is a property of this
 * listing.
 */
export async function lerAnuncioShopee(client: ShopeeClient, itemId: number): Promise<ItemLido> {
  let payload: ShopeeItemBaseInfo;
  try {
    payload = await client.getItemBaseInfo({ itemIds: [itemId] });
  } catch (err) {
    // ⚠️ `error_item_not_found` on the ENVELOPE of a one-id call is that id's
    // verdict, and nothing wider: the batch form only raises it when EVERY id of
    // the call is unknown, and here there is exactly one.
    if (
      err instanceof ShopeeApiError &&
      err.kind === SHOPEE_ERROR_KIND.other &&
      err.code === CODIGO_ITEM_NAO_ENCONTRADO
    ) {
      throw new ShopeeImportBlockedError(
        MOTIVO_IMPORT_BLOQUEADO.itemNaoEncontrado,
        itemId,
        MSG_ITEM_NAO_ENCONTRADO,
      );
    }
    throw err;
  }

  // ⚠️ A row that did not parse is the payload schema's `null` sentinel, not an
  // absent row: it is dropped here and named by its OWN sentence, because
  // "o anúncio não existe nesta loja" would be false about a listing that
  // answered.
  const legiveis = payload.item_list.filter((linha) => linha !== null);
  if (!legiveis.some((linha) => linha.item_id === itemId)) {
    throw new ShopeeImportBlockedError(
      MOTIVO_IMPORT_BLOQUEADO.itemNaoEncontrado,
      itemId,
      legiveis.length < payload.item_list.length ? MSG_ITEM_LINHA_ILEGIVEL : MSG_ITEM_SEM_LINHA,
    );
  }

  // The record as read so far — the ONLY honest way to ask `tag.kit` and
  // `has_model`, because both are resolved fields of the assembled row rather
  // than raw payload keys.
  const semDetalhe = montarItemLido({ itemId, payload, linha: null });

  if (ehKitDe(semDetalhe.base)) {
    const detalhe = await client.getKitItemInfo({ itemId });
    if (detalhe.product_info === null) {
      throw new ShopeeImportBlockedError(
        MOTIVO_IMPORT_BLOQUEADO.kitSemDetalhe,
        itemId,
        MSG_KIT_SEM_DETALHE,
      );
    }
    return montarItemLido({ itemId, payload, linha: null, kit: detalhe.product_info });
  }

  if (!temModelosDe(semDetalhe)) return semDetalhe;

  const modelos = await client.getModelList({ itemId });
  return montarItemLido({ itemId, payload, linha: null, modelos });
}
