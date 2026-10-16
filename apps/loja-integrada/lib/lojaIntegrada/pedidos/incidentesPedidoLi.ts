/**
 * The order import's NON-BLOCKING incidentes (master plan step 5, PR 5-c, import
 * step 11): one `pedidos/{pedidoId}/incidentes/{id}` document per problem the
 * operator must see on the pedido's Incidentes tab, none of which stops the
 * order from importing.
 *
 *  - `li-produto-nao-vinculado` — a line no rung bound (`vinculoProdutoLi.ts`):
 *    it keeps `produtoUid: null` under `'NONE'`, inert for stock;
 *  - `li-multi-envio` — the order carries more than one shipment: the first one
 *    drives the freight block, the rest are not imported (never expected);
 *  - `li-cliente-sem-identidade` — the buyer has no valid document and matches
 *    no cliente, so the pedido has no cliente and no endereço;
 *  - `li-totais-divergentes` — the lines, the discount and the freight do not
 *    add up to the order's total (the line residual, the shipment value, or the
 *    stored totals check of `pedidoMapeamento.ts`). Reported, never adjusted.
 *
 * ## Tier 0, and they can never block
 *
 * Every id is deterministic — the line's `ensureUniqueId` for a line, a fixed
 * name otherwise — so a redelivery, the reprocess sweep and a retry after a
 * crash all land on the SAME document. `.create()` and swallow ONLY
 * `ALREADY_EXISTS` (root `CLAUDE.md` rule 6): the first row's `timestamp` is
 * kept instead of being re-dated on every replay.
 *
 * `TIPO_INCIDENTE.outros` + `ORIGEM_INCIDENTE.outros`, the Shopee and Mercado
 * Livre rows' pair: `outros` is absent from the blocking tipos AND from the
 * marketplace origens, so each gate refuses the row on its own. No new origem
 * (that would touch the pedido schemas). `subtipo` is a free passthrough key of
 * `incidenteSchema`. No buyer datum ever reaches a message.
 *
 * A line already stored WITH a produto is not a problem, whoever bound it (the
 * line merge is append-only): such a line raises nothing.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { incidenteCollection } from '@delfrance/data/admin/collections';
import { isAlreadyExists } from '@delfrance/data/admin/grpcErrors';
import { ORIGEM_INCIDENTE, TIPO_INCIDENTE, type ItemDoPedido } from '@delfrance/schemas';

import type { FalhaProdutoLi } from './vinculoProdutoLi';

/** The `subtipo` of each incidente (module header). */
export const SUBTIPO_INCIDENTE_LI = {
  produtoNaoVinculado: 'li-produto-nao-vinculado',
  multiEnvio: 'li-multi-envio',
  clienteSemIdentidade: 'li-cliente-sem-identidade',
  totaisDivergentes: 'li-totais-divergentes',
} as const;

/** The incidente document id of an unbound line. */
export function idIncidenteLinhaLi(ensureUniqueId: string): string {
  return `li-prod-${ensureUniqueId}`;
}

/** The incidente document ids of the order-wide problems. */
export const ID_INCIDENTE_LI = {
  multiEnvio: 'li-multi-envio',
  clienteSemIdentidade: 'li-cliente-sem-identidade',
  totaisDivergentes: 'li-totais-divergentes',
} as const;

export interface LinhaSemProdutoLi {
  /** The mapped line, exactly as it will be (or was) stored. */
  readonly item: ItemDoPedido;
  /** Why no rung bound it. */
  readonly via: FalhaProdutoLi;
}

export interface IncidentesDoPedidoLi {
  readonly pedidoId: string;
  /** The order's numero, for the messages. */
  readonly numero: string;
  readonly linhasSemProduto: readonly LinhaSemProdutoLi[];
  /**
   * The ensureUniqueIds of the lines ALREADY stored with a produto (module
   * header); empty for a pedido this run created.
   */
  readonly jaVinculadas: ReadonlySet<string>;
  readonly multiEnvio: boolean;
  readonly clienteSemIdentidade: boolean;
  readonly totaisDivergentes: boolean;
  /** The importer's ONE clock read, µs. */
  readonly nowUs: number;
}

/**
 * The longest name or SKU quoted in a message: `motivoDoIncidente` is capped at
 * 2 000 characters, and a refused parse AFTER the pedido landed would park the
 * notification with its avisos unwritten.
 */
const MAX_TEXTO_CITADO = 200;

/** The operator-facing text of an unbound line. */
function motivoDaLinha(linha: LinhaSemProdutoLi): string {
  const { item, via } = linha;
  const nome = (item.nomeDeVenda ?? item.ensureUniqueId ?? '—').slice(0, MAX_TEXTO_CITADO);
  const sku = (item.sku ?? '—').slice(0, MAX_TEXTO_CITADO);
  const cabecalho = `[Loja Integrada] Item "${nome}" (SKU ${sku}) `;
  const porque =
    via === 'vinculo-ambiguo' || via === 'ambiguous-sku'
      ? 'não foi vinculado: o produto da Loja Integrada (ou o SKU) corresponde a mais de um ' +
        'produto do ERP, então nenhum foi escolhido. '
      : via === 'id-externo-inexistente' || via === 'id-externo-ilegivel'
        ? 'não foi vinculado: a Loja Integrada não devolveu o produto pelo id externo da loja. '
        : 'não foi vinculado a nenhum produto do ERP. ';
  return (
    cabecalho +
    porque +
    'O item ficou sem produto: nenhum estoque foi movimentado. ' +
    'Vincule o produto manualmente no pedido.'
  );
}

const MOTIVOS = {
  multiEnvio: (numero: string) =>
    `[Loja Integrada] O pedido ${numero} tem mais de um envio. Só o primeiro foi importado no ` +
    'frete do pedido; confira os demais no painel da Loja Integrada.',
  clienteSemIdentidade: (numero: string) =>
    `[Loja Integrada] O comprador do pedido ${numero} não tem CPF ou CNPJ válido e não ` +
    'corresponde a nenhum cliente do ERP, então o pedido ficou sem cliente e sem endereço. ' +
    'Vincule o cliente manualmente no pedido.',
  totaisDivergentes: (numero: string) =>
    `[Loja Integrada] Os itens, o desconto e o frete do pedido ${numero} não somam o total ` +
    'da Loja Integrada. Nada foi ajustado; confira os valores antes de emitir a NF-e.',
} as const;

/**
 * Write every incidente of one import (module header). Returns the ids it
 * CREATED — a redelivery legitimately creates none.
 */
export async function registrarIncidentesDoPedidoLi(
  db: Firestore,
  entrada: IncidentesDoPedidoLi,
): Promise<string[]> {
  const { pedidoId, numero, nowUs } = entrada;
  const planos: { id: string; subtipo: string; motivo: string; externalId: string | null }[] = [];

  for (const linha of entrada.linhasSemProduto) {
    const { item } = linha;
    if (item.produtoUid != null || item.ensureUniqueId == null) continue;
    if (entrada.jaVinculadas.has(item.ensureUniqueId)) continue;
    planos.push({
      id: idIncidenteLinhaLi(item.ensureUniqueId),
      subtipo: SUBTIPO_INCIDENTE_LI.produtoNaoVinculado,
      motivo: motivoDaLinha(linha),
      externalId: item.mktplaceId,
    });
  }
  for (const [chave, ativo] of [
    ['multiEnvio', entrada.multiEnvio],
    ['clienteSemIdentidade', entrada.clienteSemIdentidade],
    ['totaisDivergentes', entrada.totaisDivergentes],
  ] as const) {
    if (!ativo) continue;
    planos.push({
      id: ID_INCIDENTE_LI[chave],
      subtipo: SUBTIPO_INCIDENTE_LI[chave],
      motivo: MOTIVOS[chave](numero),
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
