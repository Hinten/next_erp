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
 *    no cliente, so the pedido has no cliente (and no endereço, unless one was
 *    already stored — the text says which);
 *  - `li-endereco-de-outro-cliente` — an endereço the pedido stores (the fiscal
 *    one, or the freight block's delivery one) is not stored under the cliente
 *    the pedido carries — the stored one, else the one this import resolved —
 *    or one of the two cannot be read: the import links no cliente over it and
 *    fills no carrier route (`importarPedido.ts`, step 7). The text names each
 *    endereço and its reason, and says a cliente was withheld only when one
 *    was;
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
  enderecoDeOutroCliente: 'li-endereco-de-outro-cliente',
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
  enderecoDeOutroCliente: 'li-endereco-de-outro-cliente',
  totaisDivergentes: 'li-totais-divergentes',
} as const;

export interface LinhaSemProdutoLi {
  /** The mapped line, exactly as it will be (or was) stored. */
  readonly item: ItemDoPedido;
  /** Why no rung bound it. */
  readonly via: FalhaProdutoLi;
}

/** One of the pedido's two endereços: the fiscal one, or the freight block's delivery one. */
export type UsoEnderecoLi = 'fiscal' | 'entrega';

/**
 * The cliente the pedido's stored endereços were compared against: the one it
 * already holds (`armazenado`), the one this import resolved while none was
 * stored (`resolvido`) — or why there was none to compare with: no cliente
 * at all (`ausente`), or a stored value that names no cliente (`ilegivel`).
 */
export type ClienteComparadoLi = 'armazenado' | 'resolvido' | 'ausente' | 'ilegivel';

/**
 * The stored endereços that do not pair with the pedido's cliente
 * (`importarPedido.ts`, step 7), fiscal first.
 */
export interface EnderecoNaoPareadoLi {
  readonly cliente: ClienteComparadoLi;
  /** `donoLegivel: false` — the stored value names no cliente's endereço. */
  readonly enderecos: readonly { readonly uso: UsoEnderecoLi; readonly donoLegivel: boolean }[];
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
  /** The pedido kept no cliente for a buyer with no identity; `comEndereco` — it holds an endereço. */
  readonly clienteSemIdentidade: { readonly comEndereco: boolean } | null;
  /** A stored endereço that does not pair with the pedido's cliente (module header). */
  readonly enderecoNaoPareado: EnderecoNaoPareadoLi | null;
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

const NOME_DO_ENDERECO: Readonly<Record<UsoEnderecoLi, string>> = {
  fiscal: 'o endereço fiscal',
  entrega: 'o endereço de entrega',
};

/**
 * The operator-facing text of an endereço that does not pair (module header):
 * only what is TRUE of this pedido — "another cliente" only for an owner that
 * was read, and "the cliente was not linked" only when the import withheld one.
 */
function motivoDoEnderecoNaoPareado(numero: string, n: EnderecoNaoPareadoLi): string {
  const nomes = n.enderecos.map((e) => NOME_DO_ENDERECO[e.uso]);
  let porque: string;
  if (n.cliente === 'ausente' || n.cliente === 'ilegivel') {
    const semCliente =
      n.cliente === 'ausente'
        ? 'o pedido está sem cliente'
        : 'o cliente do pedido não pôde ser identificado';
    porque = `${semCliente}, então não foi possível conferir a quem pertence ${nomes.join(' e ')}.`;
  } else {
    const deQuem = n.cliente === 'armazenado' ? 'do cliente do pedido' : 'do cliente do comprador';
    porque =
      n.enderecos
        .map((e) =>
          e.donoLegivel
            ? `${NOME_DO_ENDERECO[e.uso]} é de outro cliente, e não ${deQuem}`
            : `não foi possível identificar de qual cliente é ${NOME_DO_ENDERECO[e.uso]}`,
        )
        .join('; ') + '.';
  }
  const consequencia =
    n.cliente === 'resolvido'
      ? 'Para que nenhuma NF-e ou etiqueta use o endereço de outra pessoa, a importação não ' +
        'vinculou o cliente do comprador ao pedido nem definiu a transportadora do frete.'
      : 'Para que nenhuma etiqueta seja comprada para um endereço que pode ser de outra pessoa, ' +
        'a importação não definiu a transportadora do frete.';
  return (
    `[Loja Integrada] Pedido ${numero}: ${porque} ${consequencia} ` +
    'Confira o cliente e os endereços do pedido antes de emitir a NF-e ou a etiqueta.'
  );
}

const MOTIVOS = {
  multiEnvio: (numero: string) =>
    `[Loja Integrada] O pedido ${numero} tem mais de um envio. Só o primeiro foi importado no ` +
    'frete do pedido; confira os demais no painel da Loja Integrada.',
  clienteSemIdentidade: (numero: string, comEndereco: boolean) =>
    `[Loja Integrada] O comprador do pedido ${numero} não tem CPF ou CNPJ válido e não ` +
    'corresponde a nenhum cliente do ERP, então o pedido ficou sem cliente' +
    `${comEndereco ? '' : ' e sem endereço'}. Vincule o cliente manualmente no pedido.`,
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
  const { clienteSemIdentidade, enderecoNaoPareado } = entrada;
  for (const [chave, motivo] of [
    ['multiEnvio', entrada.multiEnvio ? MOTIVOS.multiEnvio(numero) : null],
    [
      'clienteSemIdentidade',
      clienteSemIdentidade === null
        ? null
        : MOTIVOS.clienteSemIdentidade(numero, clienteSemIdentidade.comEndereco),
    ],
    [
      'enderecoDeOutroCliente',
      enderecoNaoPareado === null ? null : motivoDoEnderecoNaoPareado(numero, enderecoNaoPareado),
    ],
    ['totaisDivergentes', entrada.totaisDivergentes ? MOTIVOS.totaisDivergentes(numero) : null],
  ] as const) {
    if (motivo === null) continue;
    planos.push({
      id: ID_INCIDENTE_LI[chave],
      subtipo: SUBTIPO_INCIDENTE_LI[chave],
      motivo,
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
