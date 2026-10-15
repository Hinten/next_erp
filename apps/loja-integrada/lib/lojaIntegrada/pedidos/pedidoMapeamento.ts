/**
 * A Loja Integrada order → the `pedidos/{id}` write (master plan step 5, PR
 * 5-b): the fields the order gives ({@link mapearPedidoLi}), and the write
 * against the STORED document — a create body, or an update patch built group
 * by group ({@link montarEscritaPedidoLi}).
 *
 * PURE: no Firestore, no clock (`nowUs` is a parameter). The importer reads the
 * snapshot, hands its raw data here, and writes what comes back — a create, or
 * an update under a `lastUpdateTime` precondition. On a lost precondition it
 * re-reads and calls this again: every group is re-derived from the snapshot it
 * is handed, and nothing decided against an older one is re-applied.
 *
 * ## The fields
 *
 * `ehSaida: true`; `numero` as text; `integracaoPedidoOuterRef` the conta;
 * `operacaoPedidoOuterRef` the conta's operação; the estado (step-5 decision);
 * `valorCobrado = valor_total`; `descontoTotal = valor_desconto` plus the
 * positive line residual; `timestamp` the order's creation stamp and
 * `lastMarketplaceUpdate` its modification stamp, both through
 * `dataLiParaMicros`; the lines; `freteInicial`; the cliente and endereço refs;
 * `error` only as the importer's own prefixed text. No filial, no `marketplace`
 * block, no status echo.
 *
 * ## The watermark
 *
 * The incoming stamp is LI's naive time, converted once by `dataLiParaMicros`.
 * A stored stamp may come from another writer, in another unit or zone; it is
 * read through `coerceToMicros`, and a migrated pedido's first new observation
 * re-applies, which the window rehearsal verifies. A stored stamp strictly
 * newer ⇒ `obsoleto`, with nothing written; equal or older ⇒ the patch is
 * built, and an EMPTY patch writes nothing (`sem-mudanca`) — so an equal-stamp
 * redelivery that binds a newly linked line still applies. The accepted value
 * is written, never a max.
 *
 * ## The update groups (the Shopee freeze split)
 *
 * | Group | Rule |
 * |---|---|
 * | watermark | as above |
 * | always | the estado (decision + ladder), our own error text |
 * | fill-once | `numero`, the refs, `timestamp`, `operacaoPedidoOuterRef` — only while stored empty |
 * | freight | the freight merge (`mesclarFreteLi`): tracking, deadline and refs outside the freeze |
 * | frozen while `hasUserInteraction` | the lines (append, and bind an unmatched line), `valorCobrado`, `descontoTotal` — and the freight money (in the merge) |
 *
 * An operator's money edit therefore survives the next Loja Integrada change,
 * and one operator save never blinds tracking or the paid promotion.
 */
import { coerceToMicros } from '@delfrance/core/datetime';
import { roundReais } from '@delfrance/core/money';
import type { PedidoLi } from '@delfrance/integrations-loja-integrada';
import { toOuterRef, type ItemDoPedido, type OuterRef } from '@delfrance/schemas';

import { PREFIXO_ERRO_LI, decidirEstadoLi, type DecisaoEstadoLi } from './estadoPedidoLi';
import { dataLiParaMicros } from './dataLi';
import { freteDeCriacaoLi, mesclarFreteLi, type FreteMapeadoLi } from './freteMapeamento';
import { idPedidoLi } from './orderIdsLi';

/* -------------------------------------------------------------------------- */
/*                                 the mapping                                 */
/* -------------------------------------------------------------------------- */

export interface EntradaPedidoLi {
  readonly contaId: string;
  /** The conta's `operacaoOuterRef`. */
  readonly operacaoOuterRef: string | null;
  readonly pedido: PedidoLi;
  /** `dataLiParaMicros(pedido.data_modificacao)`, refused upstream when unreadable. */
  readonly watermarkUs: number;
  /** The history verdict. */
  readonly capturado: boolean;
  /** `mapearItensLi`'s lines. */
  readonly itens: readonly ItemDoPedido[];
  /** `mapearItensLi`'s positive residual. */
  readonly descontoExtra: number;
  /** `mapearFreteLi`'s block, or `null` for an order with no shipment. */
  readonly frete: FreteMapeadoLi | null;
  readonly clientePedidoOuterRef: string | null;
  readonly enderecoFiscalOuterRef: string | null;
}

export interface PedidoMapeadoLi {
  readonly pedidoId: string;
  readonly watermarkUs: number;
  readonly codigo: string;
  readonly capturado: boolean;
  readonly preencherUmaVez: {
    readonly numero: string;
    readonly integracaoPedidoOuterRef: OuterRef;
    readonly operacaoPedidoOuterRef: string | null;
    /** The order's creation stamp (µs), or `null` (a create then uses now). */
    readonly timestamp: number | null;
    readonly clientePedidoOuterRef: string | null;
    readonly enderecoFiscalOuterRef: string | null;
  };
  readonly congelaveis: {
    readonly itens: readonly ItemDoPedido[];
    readonly valorCobrado: number | null;
    readonly descontoTotal: number;
  };
  readonly frete: FreteMapeadoLi | null;
}

/** The order's fields (module header). */
export function mapearPedidoLi(entrada: EntradaPedidoLi): PedidoMapeadoLi {
  const { pedido } = entrada;
  return {
    pedidoId: idPedidoLi(entrada.contaId, pedido.numero),
    watermarkUs: entrada.watermarkUs,
    codigo: pedido.situacao.codigo,
    capturado: entrada.capturado,
    preencherUmaVez: {
      numero: String(pedido.numero),
      integracaoPedidoOuterRef: toOuterRef(`integracao/${entrada.contaId}`),
      operacaoPedidoOuterRef: entrada.operacaoOuterRef,
      timestamp: dataLiParaMicros(pedido.data_criacao),
      clientePedidoOuterRef: entrada.clientePedidoOuterRef,
      enderecoFiscalOuterRef: entrada.enderecoFiscalOuterRef,
    },
    congelaveis: {
      itens: entrada.itens,
      valorCobrado: pedido.valor_total == null ? null : roundReais(pedido.valor_total),
      descontoTotal: roundReais((pedido.valor_desconto ?? 0) + entrada.descontoExtra),
    },
    frete: entrada.frete,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  the lines                                  */
/* -------------------------------------------------------------------------- */

/** A stored line, raw, with the bucket it was found in. */
interface LinhaArmazenada {
  readonly item: Readonly<Record<string, unknown>>;
  readonly produtoUid: string | null;
  readonly ensureUniqueId: string | null;
}

const SEM_PRODUTO = 'NONE';

/**
 * The stored lines, read raw: `null` when `itens` is neither absent nor a map
 * of lists (it is then left alone).
 */
function linhasArmazenadas(bruto: unknown): LinhaArmazenada[] | null {
  if (bruto === undefined || bruto === null) return [];
  if (typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const linhas: LinhaArmazenada[] = [];
  for (const [chave, lista] of Object.entries(bruto as Record<string, unknown>)) {
    if (!Array.isArray(lista)) return null;
    for (const item of lista as readonly unknown[]) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
      const linha = item as Readonly<Record<string, unknown>>;
      const proprio = typeof linha.produtoUid === 'string' ? linha.produtoUid : null;
      const daChave = chave !== '' && chave !== SEM_PRODUTO ? chave : null;
      linhas.push({
        item: linha,
        produtoUid: proprio ?? daChave,
        ensureUniqueId: typeof linha.ensureUniqueId === 'string' ? linha.ensureUniqueId : null,
      });
    }
  }
  return linhas;
}

/** `Record<produtoUid | 'NONE', item[]>` and its `itensIds`. */
function agrupar(linhas: readonly { produtoUid: string | null; item: unknown }[]): {
  itens: Record<string, unknown[]>;
  itensIds: string[];
} {
  const itens: Record<string, unknown[]> = {};
  for (const { produtoUid, item } of linhas) (itens[produtoUid ?? SEM_PRODUTO] ??= []).push(item);
  return { itens, itensIds: Object.keys(itens) };
}

/**
 * The stored lines with the incoming ones merged in, or `null` when nothing
 * changes. APPEND-ONLY: a line already stored keeps its fields — except an
 * UNMATCHED one (no produto) that the import now resolves, which is bound.
 * Nothing is ever removed.
 */
export function mesclarItensLi(
  armazenado: unknown,
  recebidos: readonly ItemDoPedido[],
): { itens: Record<string, unknown[]>; itensIds: string[] } | null {
  const linhas = linhasArmazenadas(armazenado);
  if (linhas === null) return null;
  const resultado: { produtoUid: string | null; item: unknown }[] = linhas.map((l) => ({
    produtoUid: l.produtoUid,
    item: l.item,
  }));
  const porId = new Map<string, number>();
  linhas.forEach((l, i) => {
    if (l.ensureUniqueId !== null && !porId.has(l.ensureUniqueId)) porId.set(l.ensureUniqueId, i);
  });
  let mudou = false;
  for (const recebido of recebidos) {
    const id = recebido.ensureUniqueId;
    const posicao = id === null ? undefined : porId.get(id);
    if (posicao === undefined) {
      resultado.push({ produtoUid: recebido.produtoUid, item: recebido });
      if (id !== null) porId.set(id, resultado.length - 1);
      mudou = true;
      continue;
    }
    const atual = resultado[posicao]!;
    if (atual.produtoUid === null && recebido.produtoUid !== null) {
      resultado[posicao] = {
        produtoUid: recebido.produtoUid,
        item: { ...(atual.item as Record<string, unknown>), produtoUid: recebido.produtoUid },
      };
      mudou = true;
    }
  }
  return mudou ? agrupar(resultado) : null;
}

/* -------------------------------------------------------------------------- */
/*                                  the write                                  */
/* -------------------------------------------------------------------------- */

/** Which group of the patch a field came from. */
export type GrupoPedidoLi =
  | 'watermark'
  | 'estado'
  | 'erro'
  | 'preencher-uma-vez'
  | 'frete'
  | 'itens'
  | 'dinheiro';

export type EscritaPedidoLi =
  /** No stored pedido: the full body (the importer parses it before any write). */
  | {
      readonly tipo: 'criar';
      readonly corpo: Readonly<Record<string, unknown>>;
      readonly decisao: DecisaoEstadoLi;
    }
  /** The stored watermark is strictly newer: NOTHING is written, avisos included. */
  | { readonly tipo: 'obsoleto'; readonly armazenadoUs: number }
  /** Accepted, re-derived, and nothing differs. */
  | { readonly tipo: 'sem-mudanca'; readonly decisao: DecisaoEstadoLi }
  | {
      readonly tipo: 'atualizar';
      readonly patch: Readonly<Record<string, unknown>>;
      readonly grupos: readonly GrupoPedidoLi[];
      readonly decisao: DecisaoEstadoLi;
    };

/** Nothing stored yet, for a fill-once field: `null`, absent or `''` (never `0`). */
function vazio(valor: unknown): boolean {
  return valor === null || valor === undefined || valor === '';
}

function corpoDeCriacao(
  mapeado: PedidoMapeadoLi,
  decisao: DecisaoEstadoLi,
  nowUs: number,
): Readonly<Record<string, unknown>> {
  const p = mapeado.preencherUmaVez;
  const { itens, itensIds } = agrupar(
    mapeado.congelaveis.itens.map((item) => ({ produtoUid: item.produtoUid, item })),
  );
  return {
    ehSaida: true,
    estado: decisao.estado,
    numero: p.numero,
    integracaoPedidoOuterRef: p.integracaoPedidoOuterRef,
    operacaoPedidoOuterRef: p.operacaoPedidoOuterRef,
    clientePedidoOuterRef: p.clientePedidoOuterRef,
    enderecoFiscalOuterRef: p.enderecoFiscalOuterRef,
    itens,
    itensIds,
    freteInicial: mapeado.frete === null ? null : freteDeCriacaoLi(mapeado.frete, decisao.estado),
    valorCobrado: mapeado.congelaveis.valorCobrado,
    descontoTotal: mapeado.congelaveis.descontoTotal,
    error: decisao.erro.tipo === 'definir' ? decisao.erro.mensagem : null,
    // The order's own creation stamp; "when we first saw it" only when it is unreadable.
    timestamp: p.timestamp ?? nowUs,
    ultimaModificacao: nowUs,
    lastMarketplaceUpdate: mapeado.watermarkUs,
  };
}

/**
 * The write for the order against its STORED pedido (raw snapshot data), or
 * `null` for a create (module header).
 */
export function montarEscritaPedidoLi(
  armazenado: Readonly<Record<string, unknown>> | null,
  mapeado: PedidoMapeadoLi,
  nowUs: number,
): EscritaPedidoLi {
  if (armazenado === null) {
    const decisao = decidirEstadoLi({
      armazenado: null,
      codigo: mapeado.codigo,
      capturado: mapeado.capturado,
    });
    return { tipo: 'criar', corpo: corpoDeCriacao(mapeado, decisao, nowUs), decisao };
  }

  const armazenadoUs = coerceToMicros(armazenado.lastMarketplaceUpdate);
  if (armazenadoUs !== null && mapeado.watermarkUs < armazenadoUs) {
    return { tipo: 'obsoleto', armazenadoUs };
  }

  const decisao = decidirEstadoLi({
    armazenado: { estado: armazenado.estado, estoqueAplicado: armazenado.estoqueAplicado },
    codigo: mapeado.codigo,
    capturado: mapeado.capturado,
  });
  const patch: Record<string, unknown> = {};
  const grupos = new Set<GrupoPedidoLi>();
  const definir = (campo: string, valor: unknown, grupo: GrupoPedidoLi) => {
    patch[campo] = valor;
    grupos.add(grupo);
  };

  // The watermark: the ACCEPTED value.
  if (armazenadoUs !== mapeado.watermarkUs) {
    definir('lastMarketplaceUpdate', mapeado.watermarkUs, 'watermark');
  }

  // Always: the estado and our own error text.
  if (decisao.estado !== null) definir('estado', decisao.estado, 'estado');
  if (decisao.erro.tipo === 'definir') {
    if (armazenado.error !== decisao.erro.mensagem) definir('error', decisao.erro.mensagem, 'erro');
  } else if (typeof armazenado.error === 'string' && armazenado.error.startsWith(PREFIXO_ERRO_LI)) {
    // Ours to clear — an error another writer left is never erased.
    definir('error', null, 'erro');
  }

  // Fill-once, against the RAW snapshot.
  const p = mapeado.preencherUmaVez;
  for (const [campo, valor] of [
    ['numero', p.numero],
    ['integracaoPedidoOuterRef', p.integracaoPedidoOuterRef],
    ['operacaoPedidoOuterRef', p.operacaoPedidoOuterRef],
    ['timestamp', p.timestamp],
    ['clientePedidoOuterRef', p.clientePedidoOuterRef],
    ['enderecoFiscalOuterRef', p.enderecoFiscalOuterRef],
  ] as const) {
    if (valor !== null && vazio(armazenado[campo])) definir(campo, valor, 'preencher-uma-vez');
  }

  const congelado = armazenado.hasUserInteraction === true;

  // The freight: its own two groups (`mesclarFreteLi`).
  if (mapeado.frete !== null) {
    const frete = mesclarFreteLi(armazenado.freteInicial, mapeado.frete, {
      congelado,
      estadoPedido: decisao.estadoResultante,
    });
    if (frete !== null) definir('freteInicial', frete.bloco, 'frete');
  }

  // Frozen while an operator has touched the pedido.
  if (!congelado) {
    const itens = mesclarItensLi(armazenado.itens, mapeado.congelaveis.itens);
    if (itens !== null) {
      definir('itens', itens.itens, 'itens');
      definir('itensIds', itens.itensIds, 'itens');
    }
    const { valorCobrado, descontoTotal } = mapeado.congelaveis;
    if (valorCobrado !== null && armazenado.valorCobrado !== valorCobrado) {
      definir('valorCobrado', valorCobrado, 'dinheiro');
    }
    if (armazenado.descontoTotal !== descontoTotal) {
      definir('descontoTotal', descontoTotal, 'dinheiro');
    }
  }

  if (Object.keys(patch).length === 0) return { tipo: 'sem-mudanca', decisao };
  const ultima = coerceToMicros(armazenado.ultimaModificacao);
  patch.ultimaModificacao = ultima !== null && ultima > nowUs ? ultima : nowUs;
  return { tipo: 'atualizar', patch, grupos: [...grupos], decisao };
}
