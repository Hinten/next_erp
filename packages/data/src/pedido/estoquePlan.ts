import type {
  ComponentesKit,
  EfeitoEstoquePedido,
  EstoqueAplicado,
  TipoMovimentoEstoque,
} from '@delfrance/schemas';
import { TIPO_MOVIMENTO_ESTOQUE } from '@delfrance/schemas';

/**
 * Pure planning for the pedido → estoque sync (`sincronizarEstoquePedido`,
 * apps/functions). No I/O: the Cloud Function reads (pedido, integração,
 * operação, produtos, estoques) inside its transaction and delegates every
 * decision here, so the whole movement algebra is unit-testable.
 *
 * Port of the legacy `calcularAlteracoesEstoque` + the delta arithmetic spread
 * across `managerEstoquePedido2` (`.old/packages/pedido/lib/src/tasks.dart`),
 * with the central fix for the legacy drift bug: reversals diff against the
 * pedido's `estoqueAplicado` snapshot — what was REALLY applied — never a
 * recomputation from the current items.
 */

/* -------------------------------------------------------------------------- */
/*                       Item → per-produto quantity map                      */
/* -------------------------------------------------------------------------- */

/** The produto projection kit expansion needs (a subset of the produto doc). */
export interface ProdutoParaEstoque {
  ehKit?: boolean | null;
  componentesKit?: ComponentesKit | null;
}

/**
 * The item projection the quantity map needs — a structural subset of
 * `ItemDoPedido`, so the sync can extract items tolerantly from raw Firestore
 * data (a legacy doc failing full-schema validation must still move stock).
 */
export interface ItemParaEstoque {
  produtoUid?: string | null;
  quantidade?: number | null;
}

/**
 * Flatten `pedido.itens` into `produtoId → quantidade`, expanding kits — the
 * legacy `calcularAlteracoesEstoque` (tasks.dart:12) 1:1:
 *
 *  - items without a produto link (`produtoUid` null / `'NONE'` sentinel key)
 *    are skipped — free-text lines carry no stock;
 *  - a missing produto doc skips the item (legacy: `produtos.isEmpty → continue`);
 *  - a kit contributes `item.quantidade × kit.quantidade` to each component
 *    with `limitarEstoque`, and the kit produto itself moves NO stock;
 *    components are not expanded recursively (kit-of-kit — legacy parity);
 *  - variants need no special handling: `item.produtoUid` already points at the
 *    variation child produto, which owns its own estoques.
 */
export function calcularAlteracoesEstoque(
  itens: Record<string, readonly ItemParaEstoque[]>,
  produtos: ReadonlyMap<string, ProdutoParaEstoque | null | undefined>,
): Record<string, number> {
  const alteracoes: Record<string, number> = {};
  for (const itemList of Object.values(itens)) {
    for (const item of itemList) {
      const produtoUid = item.produtoUid;
      const quantidade =
        typeof item.quantidade === 'number' && Number.isFinite(item.quantidade)
          ? item.quantidade
          : 0;
      if (!produtoUid || produtoUid === 'NONE' || quantidade <= 0) continue;
      const produto = produtos.get(produtoUid);
      if (!produto) continue;
      if (produto.ehKit) {
        const componentes = produto.componentesKit;
        if (!componentes) continue;
        for (const [componenteId, kit] of Object.entries(componentes)) {
          if (!kit.limitarEstoque) continue;
          alteracoes[componenteId] = (alteracoes[componenteId] ?? 0) + quantidade * kit.quantidade;
        }
      } else {
        alteracoes[produtoUid] = (alteracoes[produtoUid] ?? 0) + quantidade;
      }
    }
  }
  return alteracoes;
}

/* -------------------------------------------------------------------------- */
/*                            Snapshot inspection                             */
/* -------------------------------------------------------------------------- */

function vazio(mapa: Record<string, number> | null | undefined): boolean {
  return !mapa || Object.keys(mapa).length === 0;
}

/** Whether the snapshot holds a PHYSICAL movement (drives the hold hysteresis). */
export function temMovimentoAplicado(aplicado: EstoqueAplicado | null): boolean {
  return !vazio(aplicado?.removido) || !vazio(aplicado?.adicionado);
}

/** Whether the snapshot holds ANY effect (reservation or physical). */
export function temEfeitoAplicado(aplicado: EstoqueAplicado | null): boolean {
  return !vazio(aplicado?.reservado) || temMovimentoAplicado(aplicado);
}

/* -------------------------------------------------------------------------- */
/*                              Sync planning                                 */
/* -------------------------------------------------------------------------- */

export interface SincronizacaoEstoqueInput {
  /** Target per-produto quantities from the CURRENT items (kit-expanded). */
  alteracoes: Record<string, number>;
  /** Desired effect (`efeitoEstoquePedido`). */
  efeito: EfeitoEstoquePedido;
  /** Currently applied snapshot (`pedido.estoqueAplicado`; null = nothing). */
  aplicado: EstoqueAplicado | null;
  /** Depósito / operação / direction resolved from the CURRENT config —
   *  used for new applications; reversals target the snapshot's depósito. */
  depositoId: string;
  operacaoId: string | null;
  ehSaida: boolean;
  /** For the audit `motivo` / `pedidoNumero`. */
  pedidoNumero: string | null;
  /** µs since epoch (snapshot `atualizadoEm`). */
  agora: number;
  /** Forces every delta's tipo (the pedido-deletion reversal). */
  tipoOverride?: TipoMovimentoEstoque;
}

/** One estoque write the sync must perform (signed deltas). */
export interface EstoqueDelta {
  produtoId: string;
  depositoId: string;
  deltaQuantidade: number;
  deltaReservada: number;
  tipo: TipoMovimentoEstoque;
  motivo: string;
}

export interface PlanoSincronizacaoEstoque {
  /** Empty ⇒ nothing to write (the no-op-write loop guard keys off this). */
  deltas: EstoqueDelta[];
  /** Snapshot to persist alongside the deltas (null = no effect held anymore). */
  aplicadoDepois: EstoqueAplicado | null;
  /** Desired legacy-marker states (IO keeps existing timestamps when already set). */
  reservaAtiva: boolean;
  movimentoAtivo: boolean;
}

/** Per (produto × depósito) target/applied contributions, for delta + tipo. */
interface Contribuicao {
  produtoId: string;
  depositoId: string;
  resAlvo: number;
  resAplicado: number;
  remAlvo: number;
  remAplicado: number;
  addAlvo: number;
  addAplicado: number;
}

function classificarTipo(c: Contribuicao): TipoMovimentoEstoque {
  if (c.remAlvo > c.remAplicado) return TIPO_MOVIMENTO_ESTOQUE.saida;
  if (c.remAlvo < c.remAplicado) return TIPO_MOVIMENTO_ESTOQUE.devolucao;
  if (c.addAlvo > c.addAplicado) return TIPO_MOVIMENTO_ESTOQUE.entrada;
  if (c.addAlvo < c.addAplicado) return TIPO_MOVIMENTO_ESTOQUE.estorno;
  if (c.resAplicado === 0 && c.resAlvo > 0) return TIPO_MOVIMENTO_ESTOQUE.reserva;
  if (c.resAlvo === 0 && c.resAplicado > 0) return TIPO_MOVIMENTO_ESTOQUE.liberacaoReserva;
  return TIPO_MOVIMENTO_ESTOQUE.ajusteReserva;
}

const MOTIVO_POR_TIPO: Record<TipoMovimentoEstoque, (n: string) => string> = {
  reserva: (n) => `Reserva de estoque do pedido ${n}`,
  ajusteReserva: (n) => `Ajuste de reserva do pedido ${n}`,
  liberacaoReserva: (n) => `Liberação de reserva do pedido ${n}`,
  saida: (n) => `Saída de estoque do pedido ${n}`,
  devolucao: (n) => `Devolução de estoque do pedido ${n}`,
  entrada: (n) => `Entrada de estoque do pedido ${n}`,
  estorno: (n) => `Estorno de entrada do pedido ${n}`,
  exclusaoPedido: (n) => `Reversão de estoque por exclusão do pedido ${n}`,
  // The manual tipos never come from this planner (aplicarEstoque callable).
  manual: (n) => `Movimentação manual (pedido ${n})`,
  balanco: (n) => `Balanço (pedido ${n})`,
};

/**
 * Diff the desired stock effect against the applied snapshot into concrete
 * per-estoque deltas + the next snapshot. Convergent by construction:
 * `desired == applied` ⇒ zero deltas ⇒ the caller writes nothing.
 *
 * Handles mid-flight config changes: new applications target the CURRENT
 * depósito; reversals target the SNAPSHOT's depósito — so an integração whose
 * depósito changed while a pedido held stock reverses at the old depósito and
 * re-applies at the new one, and a direction flip reverses the old-direction
 * maps while applying the new ones.
 */
export function planSincronizacaoEstoque(
  input: SincronizacaoEstoqueInput,
): PlanoSincronizacaoEstoque {
  const { alteracoes, efeito, aplicado, agora } = input;

  const reservadoAlvo = efeito.reservar ? alteracoes : {};
  const removidoAlvo = efeito.remover ? alteracoes : {};
  const adicionadoAlvo = efeito.adicionar ? alteracoes : {};
  const depositoAplicado = aplicado?.depositoId ?? input.depositoId;

  const porChave = new Map<string, Contribuicao>();
  const contrib = (produtoId: string, depositoId: string): Contribuicao => {
    const chave = `${produtoId}/${depositoId}`;
    let c = porChave.get(chave);
    if (!c) {
      c = {
        produtoId,
        depositoId,
        resAlvo: 0,
        resAplicado: 0,
        remAlvo: 0,
        remAplicado: 0,
        addAlvo: 0,
        addAplicado: 0,
      };
      porChave.set(chave, c);
    }
    return c;
  };

  for (const [p, q] of Object.entries(reservadoAlvo)) contrib(p, input.depositoId).resAlvo += q;
  for (const [p, q] of Object.entries(removidoAlvo)) contrib(p, input.depositoId).remAlvo += q;
  for (const [p, q] of Object.entries(adicionadoAlvo)) contrib(p, input.depositoId).addAlvo += q;
  for (const [p, q] of Object.entries(aplicado?.reservado ?? {}))
    contrib(p, depositoAplicado).resAplicado += q;
  for (const [p, q] of Object.entries(aplicado?.removido ?? {}))
    contrib(p, depositoAplicado).remAplicado += q;
  for (const [p, q] of Object.entries(aplicado?.adicionado ?? {}))
    contrib(p, depositoAplicado).addAplicado += q;

  const numero = input.pedidoNumero ?? '(sem número)';
  const deltas: EstoqueDelta[] = [];
  for (const c of porChave.values()) {
    const deltaQuantidade = c.addAlvo - c.addAplicado - (c.remAlvo - c.remAplicado);
    const deltaReservada = c.resAlvo - c.resAplicado;
    if (deltaQuantidade === 0 && deltaReservada === 0) continue;
    const tipo = input.tipoOverride ?? classificarTipo(c);
    deltas.push({
      produtoId: c.produtoId,
      depositoId: c.depositoId,
      deltaQuantidade,
      deltaReservada,
      tipo,
      motivo: MOTIVO_POR_TIPO[tipo](numero),
    });
  }

  const semAlvo = vazio(reservadoAlvo) && vazio(removidoAlvo) && vazio(adicionadoAlvo);
  // The snapshot owns copies — the alvo aliases share `input.alteracoes`.
  const aplicadoDepois: EstoqueAplicado | null = semAlvo
    ? null
    : {
        depositoId: input.depositoId,
        operacaoId: input.operacaoId,
        ehSaida: input.ehSaida,
        reservado: vazio(reservadoAlvo) ? null : { ...reservadoAlvo },
        removido: vazio(removidoAlvo) ? null : { ...removidoAlvo },
        adicionado: vazio(adicionadoAlvo) ? null : { ...adicionadoAlvo },
        atualizadoEm: agora,
      };

  return {
    deltas,
    aplicadoDepois,
    reservaAtiva: !vazio(reservadoAlvo),
    movimentoAtivo: !vazio(removidoAlvo) || !vazio(adicionadoAlvo),
  };
}
