/**
 * The order import's NON-BLOCKING incidentes (master plan step 5, PR 5-d): one
 * `pedidos/{pedidoId}/incidentes/{id}` document per problem the operator sees
 * on the pedido's Incidentes tab, none of which stops the order from importing:
 *
 *  - `amz-prod-<orderItemId>` — a line the pedido holds with no produto (no link
 *    doc, no seller SKU, or an ambiguous link: `vinculoProdutoAmazon.ts`). It
 *    stays under `'NONE'`, inert for stock; `subtipo` = why
 *    (`unresolved` / `amazon-vinculo-ambiguo`), `externalId` = the
 *    `orderItemId`;
 *  - `amz-cliente-sem-identidade` — an APPROVED order whose pedido, as the
 *    winning attempt leaves it, holds no cliente (the buyer's document or name
 *    is not usable — without the Tax Invoicing role, every approved order);
 *  - `amz-<code>` — one per informational code the winning decision derived
 *    (plan §3 decisions 26–27): `logistica-amazon`, `valor-zerado`,
 *    `possivel-reembolso`, `cancelado-apos-envio`, `pagamento-divergente`
 *    (PR 6 adds the payment ones). `subtipo` = the code.
 *
 * ## Tier 0, and they can never block
 *
 * Every id is deterministic, so a redelivery, the reprocess sweep and a retry
 * after a crash land on the SAME document: `.create()`, swallowing ONLY
 * `ALREADY_EXISTS` (root rule 6). Created once, never reopened or rewritten by
 * the importer — the operator resolves them on the pedido. `TIPO_INCIDENTE.outros`
 * + `ORIGEM_INCIDENTE.outros` (the Shopee, Mercado Livre and Loja Integrada
 * pair): absent from the blocking tipos AND from the marketplace origens.
 *
 * The texts carry ids and closed codes only — never a buyer datum, a price, a
 * SKU or a title.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { incidenteCollection } from '@delfrance/data/admin/collections';
import { isAlreadyExists } from '@delfrance/data/admin/grpcErrors';
import { ORIGEM_INCIDENTE, TIPO_INCIDENTE } from '@delfrance/schemas';

import { INCIDENTE_PEDIDO_AMAZON, type IncidentePedidoAmazon } from './codigosPedidoAmazon';
import type { FalhaVinculoAmazon } from './vinculoProdutoAmazon';

/** The id prefix of every incidente this import files. */
const PREFIXO_INCIDENTE_AMAZON = 'amz-';

/** The incidente id of an unbound line. */
export function idIncidenteLinhaAmazon(orderItemId: string): string {
  return `${PREFIXO_INCIDENTE_AMAZON}prod-${orderItemId}`;
}

/** The incidente id (and `subtipo`) of an approved pedido with no cliente. */
export const ID_INCIDENTE_CLIENTE_SEM_IDENTIDADE_AMAZON = 'amz-cliente-sem-identidade';

/** The incidente id of an informational code. */
export function idIncidenteDoCodigoAmazon(codigo: IncidentePedidoAmazon): string {
  return `${PREFIXO_INCIDENTE_AMAZON}${codigo}`;
}

/** One unbound line the pedido holds, and why. */
export interface LinhaSemProdutoAmazon {
  readonly orderItemId: string;
  readonly via: FalhaVinculoAmazon;
}

export interface IncidentesDoPedidoAmazon {
  readonly pedidoId: string;
  /** Amazon's order id, for the texts. */
  readonly orderId: string;
  readonly linhasSemProduto: readonly LinhaSemProdutoAmazon[];
  readonly clienteSemIdentidade: boolean;
  readonly codigos: readonly IncidentePedidoAmazon[];
  /** The importer's ONE clock read, µs. */
  readonly nowUs: number;
}

const TEXTO_DO_CODIGO: Readonly<Record<IncidentePedidoAmazon, (pedido: string) => string>> = {
  [INCIDENTE_PEDIDO_AMAZON.logisticaAmazon]: (p) =>
    `[Amazon] O pedido ${p} é atendido pela Amazon (ou não pode ser atendido pelo vendedor). ` +
    'O estoque do ERP não é movimentado por ele; confira o pedido no Seller Central.',
  [INCIDENTE_PEDIDO_AMAZON.valorZerado]: (p) =>
    `[Amazon] O pedido ${p} chegou com quantidade ou preço zerado (ou ausente) em algum item. ` +
    'Um pedido de reposição ou troca pode vir assim; confira os valores antes de emitir a NF-e.',
  [INCIDENTE_PEDIDO_AMAZON.possivelReembolso]: (p) =>
    `[Amazon] O pedido ${p} indica uma possível devolução, reembolso ou extravio. ` +
    'Os itens gravados foram mantidos; confira o pedido no Seller Central.',
  [INCIDENTE_PEDIDO_AMAZON.canceladoAposEnvio]: (p) =>
    `[Amazon] O pedido ${p} foi cancelado na Amazon depois que a mercadoria saiu (ou com o ` +
    'pedido em um estado do operador). Nada foi liberado no estoque; confira o pedido.',
  [INCIDENTE_PEDIDO_AMAZON.pagamentoDivergente]: (p) =>
    `[Amazon] O pedido ${p} foi cancelado na Amazon com um pagamento em situação definida ` +
    'pelo operador. O pedido foi cancelado e o pagamento não foi alterado; confira o pagamento.',
};

function textoDaLinha(orderId: string, linha: LinhaSemProdutoAmazon): string {
  const porque =
    linha.via === 'unresolved'
      ? 'nenhum vínculo de anúncio da conta corresponde ao SKU do item'
      : 'o SKU do item corresponde a mais de um produto do ERP, então nenhum foi escolhido';
  return (
    `[Amazon] O item ${linha.orderItemId} do pedido ${orderId} ficou sem produto: ${porque}. ` +
    'Nenhum estoque foi movimentado por ele. Vincule o produto manualmente no pedido.'
  );
}

function textoClienteSemIdentidade(orderId: string): string {
  return (
    `[Amazon] O comprador do pedido ${orderId} não tem CPF ou CNPJ (ou nome) utilizável nos ` +
    'dados da Amazon, então o pedido ficou sem cliente. Vincule o cliente manualmente no pedido.'
  );
}

/**
 * Create every incidente of one import (module header). Returns the ids it
 * CREATED — a redelivery legitimately creates none.
 */
export async function registrarIncidentesDoPedidoAmazon(
  db: Firestore,
  entrada: IncidentesDoPedidoAmazon,
): Promise<string[]> {
  const { pedidoId, orderId, nowUs } = entrada;
  const planos: {
    readonly id: string;
    readonly subtipo: string;
    readonly motivo: string;
    readonly externalId: string | null;
  }[] = [];
  for (const linha of entrada.linhasSemProduto) {
    planos.push({
      id: idIncidenteLinhaAmazon(linha.orderItemId),
      subtipo: linha.via,
      motivo: textoDaLinha(orderId, linha),
      externalId: linha.orderItemId,
    });
  }
  if (entrada.clienteSemIdentidade) {
    planos.push({
      id: ID_INCIDENTE_CLIENTE_SEM_IDENTIDADE_AMAZON,
      subtipo: ID_INCIDENTE_CLIENTE_SEM_IDENTIDADE_AMAZON,
      motivo: textoClienteSemIdentidade(orderId),
      externalId: null,
    });
  }
  for (const codigo of entrada.codigos) {
    planos.push({
      id: idIncidenteDoCodigoAmazon(codigo),
      subtipo: codigo,
      motivo: TEXTO_DO_CODIGO[codigo](orderId),
      externalId: null,
    });
  }

  const criados: string[] = [];
  for (const plano of planos) {
    try {
      await incidenteCollection.docRef(db, { pedidoId }, plano.id).create(
        incidenteCollection.parse({
          origem: ORIGEM_INCIDENTE.outros,
          tipo: TIPO_INCIDENTE.outros,
          subtipo: plano.subtipo,
          motivoDoIncidente: plano.motivo,
          comentarios: null,
          timestamp: nowUs,
          ultimaModificacao: nowUs,
          externalId: plano.externalId,
          resolucao: null,
        }),
      );
      criados.push(plano.id);
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }
  return criados;
}
