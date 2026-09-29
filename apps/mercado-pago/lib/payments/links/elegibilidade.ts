import { coerceToMicros } from '@delfrance/core/datetime';
import { centavosDeReais } from '@delfrance/core/money';
import {
  LIMITES_LINK_PAGAMENTO,
  MOTIVO_RECUSA_LINK,
  STATUS_PAGAMENTO,
  coberturaDoPedido,
  estadoNFeSchema,
  linkPagamentoEmAberto,
  motivoBloqueioLinkPagamento,
  pagamentosTravadosPorNFe,
  resumirLinksPagamento,
  valorEmAbertoEmLinks,
  type EstadoPedido,
  type LinkPagamentoResumo,
  type MotivoRecusaLink,
  type PagamentoCoberturaRow,
} from '@delfrance/schemas';

/*
 * The ONE guard behind "may this batch of Mercado Pago payment links be created
 * for this pedido right now" (#367) — pure and total (no clock, no network, no
 * Firestore), so the route runs it twice on different inputs:
 *
 *  - `criarLinks` runs it as an ADVISORY pre-check, on reads made BEFORE the
 *    Mercado Pago preferences are POSTed (a refusal there costs no preference);
 *  - `linkStore.persistirLinks` runs it again INSIDE its transaction, on that
 *    transaction's own reads, and THAT verdict is the one that decides.
 *
 * Every input arrives as a raw document view (`{ id, data: unknown }`): a stored
 * link or pagamento may be a legacy row, so nothing here trusts a shape. The
 * arithmetic is integer centavos throughout (`centavosDeReais`), never a float
 * comparison.
 */

/** What {@link avaliarElegibilidade} needs. Every field is a view of a `tx.get`. */
export interface EntradaElegibilidade {
  /**
   * The pedido, as far as the guard is concerned. `estado` is already a valid
   * `EstadoPedido` (the caller refuses an unreadable one before calling);
   * `valorCobrado` / `itensDevolvidos` may be raw snapshot values.
   */
  pedido: {
    ehSaida: boolean | null | undefined;
    estado: EstadoPedido;
    valorCobrado: number | null | undefined;
    itensDevolvidos?: unknown;
  };
  /** Every pagamento of the pedido (the whole subcollection), raw. */
  pagamentos: ReadonlyArray<{ id: string; data: unknown }>;
  /** Every link of the pedido — cancelled, expired and legacy included — raw. */
  links: ReadonlyArray<{ id: string; data: unknown }>;
  /** `canalDecideOEstado(...)`, decided in the SAME transaction. Fails closed. */
  canalMarketplace: boolean;
  /** {@link nfeMaisRecenteTravaPagamentos}, decided in the SAME transaction. */
  pagamentosTravadosPorNFe: boolean;
  /**
   * The batch asked for: what each link charges and how many payments it accepts
   * (`1` for an individual link, `quantidadeMaxima` for a shared one).
   */
  novos: ReadonlyArray<{ valor: number; quantidade: number }>;
  /** The pedido total the operator SAW when they split it. */
  valorCobradoEsperado: number;
  /** The clock, epoch ms — decides which stored links have already lapsed. */
  agoraMs: number;
}

/** A plain-object view of a raw value; anything else reads as empty. */
function comoRegistro(valor: unknown): Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

/** A finite number, or 0 — the fail-safe read the reconcile applies to `valorCobrado`. */
function numeroOuZero(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : 0;
}

/**
 * One stored pagamento as the coverage sum reads it — the SAME mapping the payment
 * reconcile applies (`coberturaRowOf` in `@delfrance/data`'s `pedidoReconcile`), so
 * the `restante` this guard sizes links against is literally the figure the
 * reconcile settles the pedido with. A link batch that sums to a `restante`
 * computed any other way could land one centavo short of `pago` and never settle.
 *
 * `status_pagamento`: `null` / absent is "paying" (the canonical rule); a number is
 * read as stored; anything else (a corrupt row) becomes `NaN`, which equals no
 * status and therefore does NOT pay — what the reconcile does with a stray string.
 */
function linhaDeCobertura(dados: unknown): PagamentoCoberturaRow {
  const d = comoRegistro(dados);
  const status = d.status_pagamento;
  return {
    valor: typeof d.valor === 'number' ? d.valor : 0,
    status_pagamento: status == null ? null : typeof status === 'number' ? status : Number.NaN,
    forma_de_pagamento: typeof d.forma_de_pagamento === 'number' ? d.forma_de_pagamento : null,
  };
}

/**
 * The statuses a Mercado Pago payment can still leave for `aprovado` — money in
 * FLIGHT: it pays nothing yet (so `restante` does not see it), but it may land.
 */
const STATUS_EM_TRANSITO: ReadonlySet<number> = new Set([
  STATUS_PAGAMENTO.pendente,
  STATUS_PAGAMENTO.em_revisao,
  STATUS_PAGAMENTO.em_processo_aprovacao,
]);

/**
 * Centavos in flight on links the open-link term does NOT cover: Σ `valor` of the
 * pagamentos whose `linkPagamentoId` names a STORED link that
 * {@link linkPagamentoEmAberto} says is not open (`expirado`, `cancelado`, `pago`,
 * `legado`) and whose `status_pagamento` is still {@link STATUS_EM_TRANSITO}.
 *
 * Why it exists: a Pix issued before a link expired (or was cancelled, or before
 * its quota filled) can still be approved afterwards, and the moment its link stops
 * being open that money drops out of `valorEmAbertoEmLinks` while `restante` has
 * not seen it either — so without this term a new link sized to the full
 * `restante` would overpay the pedido when the pending payment lands.
 *
 * A link still counted as OPEN is excluded on purpose: its pending payment is
 * already inside `valor × restantes` (a pending payment does not consume a slot).
 * Rows are raw: a missing / non-numeric status or a non-string link id is not in
 * flight, and a `valor` that is not a positive finite number adds nothing.
 */
function centavosEmTransitoForaDeLinksAbertos(
  resumos: ReadonlyArray<LinkPagamentoResumo>,
  pagamentos: ReadonlyArray<{ id: string; data: unknown }>,
): number {
  const naoAbertos = new Set(
    resumos.filter((resumo) => !linkPagamentoEmAberto(resumo)).map((resumo) => resumo.linkId),
  );
  let centavos = 0;
  for (const pagamento of pagamentos) {
    const d = comoRegistro(pagamento.data);
    const linkId = d.linkPagamentoId;
    if (typeof linkId !== 'string' || !naoAbertos.has(linkId)) continue;
    const status = d.status_pagamento;
    if (typeof status !== 'number' || !STATUS_EM_TRANSITO.has(status)) continue;
    const valor = d.valor;
    if (typeof valor === 'number' && Number.isFinite(valor) && valor > 0) {
      centavos += centavosDeReais(valor);
    }
  }
  return centavos;
}

/**
 * The first reason this batch of links cannot be created, or `null` when it can.
 * Checked in this order, so the answer never depends on which surface ran first:
 *
 * 1. `valorDesatualizado` — the pedido total the operator split is not the stored
 *    one (compared in centavos). Money-sized links built on a stale total would
 *    not add up to what is owed.
 * 2. {@link motivoBloqueioLinkPagamento} — `entrada` / `canal` / `estado` / `nfe` /
 *    `semValor`, over the `restante` from `coberturaDoPedido` (the ONE "still to
 *    pay" rule: payments plus a troca's devolução credit).
 * 3. `limiteLinks` — the pedido would hold more than
 *    `LIMITES_LINK_PAGAMENTO.linksPorPedidoMax` links (every stored link counts,
 *    cancelled and legacy included: the tab lists them all from one page).
 * 4. `excedeRestante` — the EXPOSURE: what the new links could bring in
 *    (Σ `valor × quantidade`) plus what the links still open could bring in
 *    ({@link valorEmAbertoEmLinks}) plus the money IN FLIGHT on links that are no
 *    longer open ({@link centavosEmTransitoForaDeLinksAbertos}) is more than
 *    `restante`. There is NO tolerance: an overpayment blocks the pedido's NF-e
 *    (cStat 866 — Mercado Pago money is never tPag 01 dinheiro, so no troco is
 *    allowed). A payment that has not landed does not change `valorPago`, so
 *    without the open-link term two operators (or two tabs) creating DIFFERENT
 *    batches would each fit `restante` on their own and together expose twice as
 *    much — and without the in-flight term a Pix issued before its link expired
 *    would land on top of a new link sized to the whole `restante`.
 *
 * The open-link term counts only TRACEABLE links (`modo != null`) that are still
 * `aberto` / `parcial`; a legacy link, a paid one, a cancelled one and one past its
 * `dataExpiracao` count for nothing THERE — only their attributed payments that are
 * still pending / in review / in approval count, through the in-flight term. A
 * malformed entry in `novos` (non-finite, non-positive, or a non-integer quantity)
 * is refused as `excedeRestante` — the wire schema already rejects them, so this
 * only closes the gap should a caller skip it.
 */
export function avaliarElegibilidade(e: EntradaElegibilidade): MotivoRecusaLink | null {
  const valorCobrado = numeroOuZero(e.pedido.valorCobrado);
  if (
    !Number.isFinite(e.valorCobradoEsperado) ||
    centavosDeReais(e.valorCobradoEsperado) !== centavosDeReais(valorCobrado)
  ) {
    return MOTIVO_RECUSA_LINK.valorDesatualizado;
  }

  const { restante } = coberturaDoPedido(
    {
      valorCobrado,
      ehSaida: e.pedido.ehSaida,
      itensDevolvidos: e.pedido.itensDevolvidos,
    },
    e.pagamentos.map((pagamento) => linhaDeCobertura(pagamento.data)),
  );

  const bloqueio = motivoBloqueioLinkPagamento({
    ehSaida: e.pedido.ehSaida,
    estado: e.pedido.estado,
    canalMarketplace: e.canalMarketplace,
    pagamentosTravadosPorNFe: e.pagamentosTravadosPorNFe,
    restante,
  });
  if (bloqueio !== null) return bloqueio;

  if (e.links.length + e.novos.length > LIMITES_LINK_PAGAMENTO.linksPorPedidoMax) {
    return MOTIVO_RECUSA_LINK.limiteLinks;
  }

  let centavosNovos = 0;
  for (const { valor, quantidade } of e.novos) {
    const porPagamento = Number.isFinite(valor) ? centavosDeReais(valor) : 0;
    if (porPagamento < 1 || !Number.isSafeInteger(quantidade) || quantidade < 1) {
      return MOTIVO_RECUSA_LINK.excedeRestante;
    }
    centavosNovos += porPagamento * quantidade;
  }
  const resumos = resumirLinksPagamento({
    links: e.links,
    pagamentos: e.pagamentos,
    agoraMs: e.agoraMs,
  });
  const centavosEmAberto = centavosDeReais(valorEmAbertoEmLinks(resumos));
  const centavosEmTransito = centavosEmTransitoForaDeLinksAbertos(resumos, e.pagamentos);
  if (centavosNovos + centavosEmAberto + centavosEmTransito > centavosDeReais(restante)) {
    return MOTIVO_RECUSA_LINK.excedeRestante;
  }
  return null;
}

/**
 * Whether the pedido's NF-e locks its pagamentos — the SAME rule the pedido editor
 * applies (`PedidoForm`: the pedido's NEWEST NF-e is `cancelada` / `numeracaoInutilizada`,
 * or `aprovada` while `travarPagamentoComNFe(estado)`), lifted to run on a whole
 * `nfev4` subcollection read inside a transaction.
 *
 * The editor asks Firestore for `orderBy(ultima_modificacao desc).limit(1)`; a
 * transaction reads the whole (small) subcollection instead, because that query
 * needs an index and a plain collection read does not. "Newest" is the greatest
 * `ultima_modificacao`, compared in microseconds (`coerceToMicros`, so a legacy
 * millisecond stamp and a microsecond one order correctly); a row with no readable
 * stamp is the oldest. Three deliberate fail-closed edges, each the safe direction
 * for a guard whose failure is an overpaid, un-emittable pedido:
 *
 *  - several rows TIED for newest → the pedido is locked if ANY of them locks it;
 *  - a newest row whose `estado` is present but not a known `EstadoNFe` → locked
 *    (we cannot tell that it does NOT lock);
 *  - an absent `estado` reads as no lock (the schema default is `gerado`).
 *
 * No NF-e at all → not locked.
 */
export function nfeMaisRecenteTravaPagamentos(
  nfes: ReadonlyArray<{ id: string; data: unknown }>,
  estadoPedido: EstadoPedido,
): boolean {
  const linhas = nfes.map((nfe) => {
    const dados = comoRegistro(nfe.data);
    return {
      estado: dados.estado,
      carimbo: coerceToMicros(dados.ultima_modificacao) ?? Number.NEGATIVE_INFINITY,
    };
  });
  const maisRecente = Math.max(Number.NEGATIVE_INFINITY, ...linhas.map((l) => l.carimbo));
  return linhas
    .filter((l) => l.carimbo === maisRecente)
    .some((l) => {
      if (l.estado == null) return false;
      const lido = estadoNFeSchema.safeParse(l.estado);
      return !lido.success || pagamentosTravadosPorNFe(lido.data, estadoPedido);
    });
}
