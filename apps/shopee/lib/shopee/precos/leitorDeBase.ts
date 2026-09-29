/**
 * The BATCHED `get_item_base_info` read of the Shopee price sync (#1521, step
 * 13) — one memoised reader per request (the manual push) or per dispatch (the
 * job), shared by every item that request or dispatch sends.
 *
 * ⚠️ **Why batched, on BOTH surfaces.** The base read is the one call every
 * item needs (it carries the fresh status, whether the listing has models and,
 * for a listing without them, its price). Fifty per-item reads per manual
 * request would spend the per-APPLICATION quota every conta shares — and a
 * large slice of the request's deadline — on what ONE call of up to
 * `SHOPEE_ITEM_BASE_INFO_MAX_IDS` ids answers. `get_model_list` has no batch
 * form and stays per has-model item, in `leituraPreco.ts`.
 *
 * ⚠️ **The staleness bound is one request or one dispatch.** The reader lives
 * exactly as long as the surface that built it, so a row it answers was read
 * at most that long ago; nothing here outlives it, and nothing here is a cache
 * across requests.
 *
 * What the reader promises, each pinned by a test:
 *
 * - **Lazy, one call per chunk.** Construction issues nothing. The ids are
 *   de-duplicated (first occurrence keeps its place) and cut into chunks of at
 *   most `SHOPEE_ITEM_BASE_INFO_MAX_IDS`, in the order given; the FIRST read of
 *   an id issues its chunk's call, and every later read of any id of that chunk
 *   is answered from the memo. Fifty distinct ids cost one call; fifty-one cost
 *   two — and only once something in the second chunk is actually read, so a
 *   run cut short by its deadline never pays for items it did not reach.
 * - **A memo of the PROMISE, not of the answer.** Concurrent readers of one
 *   chunk share the ONE call in flight, and share its rejection too.
 * - **Reconciled by `item_id`, never by position.** The answer may carry FEWER
 *   rows than were asked for, in any order; a by-position read would hand one
 *   listing another listing's status and price, silently, for every item after
 *   the gap. An id with no row answers `null` — the sender's
 *   `anuncio-inexistente` — and when several rows carry the same id, the first
 *   one wins (step 9's `montarItemLido` rule).
 * - **A row the payload schema could not read** arrives as the schema's `null`
 *   sentinel (per-element tolerance, so one malformed listing does not cost the
 *   other forty-nine). It is dropped, its id then reads as absent, and ONE
 *   `console.warn` per chunk counts the holes — so a wire drift that turns
 *   healthy listings into "listing not found" leaves a log line behind.
 * - **A chunk Shopee answers with `error_item_not_found`** (either spelling,
 *   with or without the module prefix) is the batch verdict "none of these ids
 *   exists" — the rule the catalogue import's drain already applies to the same
 *   call — so every id of that chunk answers `null` and the verdict is
 *   memoised. Propagating it instead would hand every item of the chunk the
 *   same classification anyway, one throw at a time.
 * - **What the memo FORGETS.** A failure a second attempt could change — a
 *   network failure, an HTTP 5xx without an envelope, a Shopee error of the
 *   `transient` kind, a token refresh held by another worker — is dropped from
 *   the memo once every reader in flight has received it, so the manual push's
 *   retry ladder (thrown errors only) re-issues the read instead of re-reading
 *   a memoised failure. Every other rejection STAYS: a rate limit (the sender
 *   pauses; asking again at once is exactly what the limit forbids), a revoked
 *   authorization, a deterministic refusal, a schema failure. Re-issuing one of
 *   those per item would spend a call per item to hear the same answer.
 * - **A caller bug is a `ShopeeConfigError`, before any call.** An id that is
 *   not a positive safe integer refuses construction; a read of an id the
 *   reader was not built with rejects without issuing anything. Both are OUR
 *   misconfiguration, never a listing's failure row.
 *
 * Every error the package throws reaches the reader's caller as the SAME
 * instance: the sender owns the ladder that turns them into rows, pauses and
 * fatals, and this module catches nothing it does not rethrow.
 */
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_ITEM_BASE_INFO_MAX_IDS,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  shopeeCodeSemPrefixoDeModulo,
  type ShopeeClient,
  type ShopeeItemBaseInfoRow,
} from '@delfrance/integrations-shopee';

import { ShopeeRefreshEmAndamentoError } from '../core/tokenStore';

/**
 * One item's `get_item_base_info` row, or `null` when the batched answer
 * carried no readable row for it.
 */
export type LeitorDeBase = (itemId: number) => Promise<ShopeeItemBaseInfoRow | null>;

/** The batch verdict "none of the ids of this call exists", compared on the STRIPPED code. */
const CODIGO_LOTE_DESCONHECIDO = 'error_item_not_found';

/** Log tag of this folder. */
const TAG_LOG = '[shopee/preco]';

/** A chunk's answer: the readable rows, keyed by `item_id`. */
type RespostaDoLote = ReadonlyMap<number, ShopeeItemBaseInfoRow>;

/**
 * Is `err` the batch verdict "none of these ids exists"?
 *
 * The two derived classes are narrowed FIRST: both extend `ShopeeApiError`, and
 * neither is ever a verdict about the ids.
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

/**
 * Could a second attempt of the same read answer differently? Only these
 * failures are forgotten by the memo; every other rejection stays memoised.
 */
function falhaQueUmaNovaLeituraPodeMudar(err: unknown): boolean {
  if (err instanceof ShopeeRateLimitError || err instanceof ShopeeReauthRequiredError) {
    return false;
  }
  if (err instanceof ShopeeApiError) return err.kind === SHOPEE_ERROR_KIND.transient;
  if (err instanceof ShopeeHttpError) return err.httpStatus >= 500;
  return err instanceof ShopeeNetworkError || err instanceof ShopeeRefreshEmAndamentoError;
}

/** ONE `get_item_base_info` call, reconciled by `item_id`. */
async function lerLote(client: ShopeeClient, itemIds: readonly number[]): Promise<RespostaDoLote> {
  let payload: Awaited<ReturnType<ShopeeClient['getItemBaseInfo']>>;
  try {
    payload = await client.getItemBaseInfo({ itemIds });
  } catch (err) {
    if (ehLoteDesconhecido(err)) return new Map();
    throw err;
  }

  const porId = new Map<number, ShopeeItemBaseInfoRow>();
  let ilegiveis = 0;
  for (const linha of payload.item_list) {
    if (linha === null) {
      ilegiveis += 1;
      continue;
    }
    if (!porId.has(linha.item_id)) porId.set(linha.item_id, linha);
  }
  if (ilegiveis > 0) {
    console.warn(
      `${TAG_LOG} get_item_base_info devolveu linha(s) ilegível(is) — o item sem linha legível lê como ausente`,
      { ilegiveis, pedidos: itemIds.length, legiveis: porId.size },
    );
  }
  return porId;
}

/**
 * Build the batched base reader over `itemIds`.
 *
 * @throws ShopeeConfigError when an id is not a positive safe integer — before
 *   any call, and at construction, because every later read would carry it.
 */
export function criarLeitorDeBaseEmLote(
  client: ShopeeClient,
  itemIds: readonly number[],
): LeitorDeBase {
  const unicos = [...new Set(itemIds)];
  unicos.forEach((itemId, posicao) => {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      throw new ShopeeConfigError(
        `criarLeitorDeBaseEmLote: item_id deve ser um inteiro positivo (posição ${String(posicao)}, recebido: ${JSON.stringify(itemId)}).`,
      );
    }
  });

  const lotes: (readonly number[])[] = [];
  for (let inicio = 0; inicio < unicos.length; inicio += SHOPEE_ITEM_BASE_INFO_MAX_IDS) {
    lotes.push(unicos.slice(inicio, inicio + SHOPEE_ITEM_BASE_INFO_MAX_IDS));
  }
  const loteDoItem = new Map<number, number>();
  lotes.forEach((lote, indice) => {
    for (const itemId of lote) loteDoItem.set(itemId, indice);
  });
  const memo = new Map<number, Promise<RespostaDoLote>>();

  async function lerLoteLembrando(indice: number, ids: readonly number[]): Promise<RespostaDoLote> {
    try {
      return await lerLote(client, ids);
    } catch (err) {
      // Not a fallback: every reader in flight still receives `err`. The memo
      // only FORGETS a failure a retry could change, so the next read re-issues.
      if (falhaQueUmaNovaLeituraPodeMudar(err)) memo.delete(indice);
      throw err;
    }
  }

  return async (itemId: number): Promise<ShopeeItemBaseInfoRow | null> => {
    const indice = loteDoItem.get(itemId);
    const ids = indice === undefined ? undefined : lotes[indice];
    if (indice === undefined || ids === undefined) {
      throw new ShopeeConfigError(
        `criarLeitorDeBaseEmLote: o item ${String(itemId)} não está entre os ${String(unicos.length)} ` +
          'com que este leitor foi criado — a leitura em lote nunca busca um id fora do conjunto.',
      );
    }
    let promessa = memo.get(indice);
    if (promessa === undefined) {
      promessa = lerLoteLembrando(indice, ids);
      memo.set(indice, promessa);
    }
    const resposta = await promessa;
    return resposta.get(itemId) ?? null;
  };
}
