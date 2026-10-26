/**
 * The deterministic ids of the Loja Integrada order import (master plan steps 5
 * and 6, PR 5-b) — pure digests over EXACT preimage strings, so re-importing an
 * order always lands on the same documents (root `CLAUDE.md` rule 7, tier 0).
 *
 * ## The preimages are the corpus's, byte for byte
 *
 * The migrated pedidos and pagamentos survive the cutover WITH THEIR IDS (rule
 * 8), so a different preimage would fork every one of them on its first
 * re-import: two pedidos for one sale, or a second pagamento beside the first
 * and the paid sum doubled. `orderIdsLi.test.ts` pins both digests against the
 * master plan's vectors, character for character, and keeps the two other
 * channels' spellings UNEQUAL:
 *
 *  - pedido: `sha256("lojaIntegrada" + contaId + "-" + numero)` — the shared
 *    `preimagemPedidoLi` (`@delfrance/schemas`), the string the web's identity
 *    check hashes too (as the paid re-check route is to);
 *  - pagamento: `sha256("integracao/" + contaId + "-" + pagamentoId)` — the bare
 *    collection name, no `documents/`, no leading slash, and never normalised
 *    through an outer-ref helper;
 *  - item: `ensureUniqueId = String(itens[].id)`, NOT hashed.
 *
 * `contaId` is the `integracao` document id (the conta), never a store id, and
 * the order is keyed by its `numero` — never by the top-level `id` the detail
 * also carries.
 *
 * ## A missing or unusable key is refused HERE, before any write
 *
 * The wire schema reads an absent, `null` or `''` id alike as "no id"
 * (`pedidoTipos.ts`), and `String(null)` is the key `'null'`. So every key the
 * import writes from goes through {@link exigirChaveDeEscritaLi} or
 * {@link exigirIdPagamentoLi} first: a missing one, and a non-positive payment
 * id, is a `LiSchemaError` naming the field path (never the value). The
 * importer calls them right after its hub guard and before step 5
 * (`conferirEscritasDoDetalheLi`), so a refusal still comes before any write:
 * the `mapa` row, the cliente and the endereço of steps 6 and 7 included
 * (`importarPedido.test.ts` pins it on a conta where those steps would write).
 *
 * ⚠️ The helper owns the ALGORITHM (`sha256Hex`); the pedido's PREIMAGE is
 * `preimagemPedidoLi`'s (its template literal lives there), and this file owns
 * the pagamento's. Nothing makes either template literal safe to reformat.
 */
import { sha256Hex } from '@delfrance/data/admin';
import { LiSchemaError, type ContextoRequisicaoLi } from '@delfrance/integrations-loja-integrada';
import { preimagemPedidoLi } from '@delfrance/schemas';

/** A positive safe integer, the only form a numeric preimage part takes. */
function inteiroPositivo(valor: number): boolean {
  return Number.isSafeInteger(valor) && valor > 0;
}

/**
 * `pedidos/{id}` for one Loja Integrada order — the corpus preimage
 * `sha256(utf8("lojaIntegrada" + contaId + "-" + numero))`, `numero` as a plain
 * decimal. The preimage is the SHARED one (`preimagemPedidoLi`,
 * `@delfrance/schemas`): the web's identity check hashes the same string, as
 * the paid re-check route is to, so none of them can disagree on which pedido
 * an order is.
 *
 * @throws RangeError when `numero` is not a positive safe integer, or `contaId`
 *   is not an id a document can have — a programming error: the import has
 *   already matched the numero against the path it asked for, and the conta id
 *   is its `integracao` document's.
 */
export function idPedidoLi(contaId: string, numero: number): string {
  const preimagem = preimagemPedidoLi(contaId, String(numero));
  if (preimagem === null) {
    throw new RangeError(
      'idPedidoLi: numero precisa ser um inteiro positivo, e contaId um id de documento',
    );
  }
  return sha256Hex(preimagem);
}

/**
 * `pedidos/{pedidoId}/pagamentos/{id}` for one of the order's payments — the
 * corpus preimage `sha256(utf8("integracao/" + contaId + "-" + pagamentoId))`.
 *
 * @throws RangeError when `pagamentoId` is not a positive safe integer — run it
 *   through {@link exigirIdPagamentoLi} first.
 */
export function idPagamentoLi(contaId: string, pagamentoId: number): string {
  if (!inteiroPositivo(pagamentoId)) {
    throw new RangeError('idPagamentoLi: o id do pagamento precisa ser um inteiro positivo');
  }
  return sha256Hex(`integracao/${contaId}-${String(pagamentoId)}`);
}

/**
 * An order line's `ensureUniqueId`: the provider's line id as text, NOT hashed
 * (the corpus stores it so). Run the id through {@link exigirChaveDeEscritaLi}
 * first.
 */
export function ensureUniqueIdLi(itemId: number): string {
  return String(itemId);
}

/** The detail response a key came from: what a refusal names. */
export type RespostaDoDetalheLi = ContextoRequisicaoLi & { readonly status: number };

/** The three field paths a write is keyed on. */
export type CampoDeChaveLi = 'itens[].id' | 'envios[].id' | 'pagamentos[].id';

/** Named members of {@link CampoDeChaveLi}. */
export const CAMPO_DE_CHAVE_LI = {
  item: 'itens[].id',
  envio: 'envios[].id',
  pagamento: 'pagamentos[].id',
} as const satisfies Record<string, CampoDeChaveLi>;

function recusar(campo: CampoDeChaveLi, resposta: RespostaDoDetalheLi): LiSchemaError {
  return new LiSchemaError({
    operacao: resposta.operacao,
    caminho: resposta.caminho,
    correlationId: resposta.correlationId,
    refCredencial: resposta.refCredencial,
    status: resposta.status,
    motivo: 'formato',
    campos: [campo],
  });
}

/**
 * The id a write is keyed on, or a refusal: absent and `null` (the schema's
 * reading of `''` too) are one "no id", refused here so no key is ever built
 * out of it.
 *
 * @throws {LiSchemaError} naming `campo`, never the value.
 */
export function exigirChaveDeEscritaLi(
  valor: number | null | undefined,
  campo: CampoDeChaveLi,
  resposta: RespostaDoDetalheLi,
): number {
  if (valor == null) throw recusar(campo, resposta);
  return valor;
}

/**
 * A payment's id, or a refusal: missing (as above), zero or negative. The wire
 * reads it with `wireInt()`, which accepts both, and a pagamento keyed on `0`
 * would be one document for every payment the platform failed to number.
 *
 * @throws {LiSchemaError} naming `pagamentos[].id`, never the value.
 */
export function exigirIdPagamentoLi(
  valor: number | null | undefined,
  resposta: RespostaDoDetalheLi,
): number {
  const id = exigirChaveDeEscritaLi(valor, CAMPO_DE_CHAVE_LI.pagamento, resposta);
  if (!inteiroPositivo(id)) throw recusar(CAMPO_DE_CHAVE_LI.pagamento, resposta);
  return id;
}
