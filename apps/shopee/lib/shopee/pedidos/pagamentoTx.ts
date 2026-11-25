/**
 * The SECOND Firestore write of the Shopee order import (#1514, step 6, plan
 * §3.0-W W10) — `pedidos/{pedidoId}/pagamentos`, create-or-update, in its own
 * transaction.
 *
 * ## Why a second transaction rather than widening step 5's
 *
 * `salvarPedidoShopee` is the PEDIDO's. Folding this in would make ONE OCC abort
 * re-run two mappers over one payload, and — the load-bearing half — the
 * pagamento write must be able to run on a pedido that came out
 * `ignorado-sem-mudanca`: the escrow carries no clock of its own and Shopee's
 * `escrow_amount` is documented to move until the order completes, so the money
 * can change while the order row does not. The two run one after the other, so
 * the widest window here is one Firestore round trip rather than a network one —
 * which is why this is class **B** and step 5's is C.
 *
 * ## The named guard (ADR 0011 tier 2, in MICROseconds)
 *
 * The mapped bodies are built OUTSIDE the callback by `mapearPagamentosShopee`
 * and re-applied verbatim on an OCC retry, so every decision is re-derived from
 * this transaction's own reads:
 *
 *  - the PEDIDO's stored `lastMarketplaceUpdate` — through `coerceToMicros`,
 *    because the legacy corpus holds ms ints and ISO strings THERE, and never
 *    `microsDeSegundosShopee`, which is for the SECONDS side — compared against
 *    the incoming watermark, accepting `>=` for the two reasons step 5 gives
 *    (ML's convergence argument and Shopee's 1-second resolution). Strictly
 *    older DROPS as `ignorado-obsoleto`;
 *  - `congelado` from the pedido's own `hasUserInteraction`;
 *  - the status ladder from the STORED `status_pagamento`, through
 *    `statusPagamentoAplicavel`;
 *  - every fill-once test off the RAW stored pagamento.
 *
 * ⚠️ A pedido that does not exist is REFUSED (`ignorado-sem-pedido`) rather than
 * tolerated: a subcollection under a missing ancestor is perfectly legal in
 * Firestore, so nothing would fail — the pagamentos would simply be unreachable
 * from `/pedidos` and invisible to the NF-e.
 *
 * ## The second read is the whole subcollection, and it is not optional
 *
 * `tx.get(pagamentoCollection.ref(db, { pedidoId }))` — the atomic query read the
 * client SDK cannot do (`packages/data/src/admin/pedidoReconcile.ts` is the
 * precedent). A BR combined payment fans out to N documents and a later delivery
 * may carry FEWER entries — whether `payment_info` survives past `READY_TO_SHIP`
 * is settle-live register item 22 and is NOT yet known; a later delivery that
 * re-took the primary's `valor` while an earlier delivery's siblings still stood
 * would put Σ pagante at nearly twice the nota. On a marketplace
 * `canalDevolveTroco` is FALSE, so that is a hard SEFAZ 865/866 for ever, not a
 * warning.
 *
 * Which stored documents are OURS is decided by RECOMPUTING the ids
 * (`idsDePagamentoDaOrdemShopee`: every numeric leg plus the `<order_sn>-desconto`
 * cupom leg, the legacy identity) — never by the `id` FIELD, which rides
 * `...base` through the operator's form and is therefore reachable by a hand
 * edit. A migrated legacy cupom document is therefore one of ours and is
 * updated in place, never duplicated by a `create`.
 *
 * ## Nothing is ever deleted, and while DATA is frozen nothing is ADDED either
 *
 * A pagamento the operator removed is RECREATED on the next delivery (the money
 * really moved), and a surplus document from a richer earlier delivery keeps its
 * own `valor`. Deleting would be the one irreversible thing this path could do.
 *
 * ⚠️ The freeze has TWO directions and they cost the same. A delivery that LOST
 * payment detail (below) is `degradado` and must not re-take the primary's
 * `valor`; a delivery that maps MORE legs while the DATA group is frozen must
 * not CREATE the extra ones — the stored primary is still standing at whatever
 * a poorer earlier delivery gave it (often the whole `valorCobrado`, because
 * that delivery carried no `payment_info`), so a new sibling at its own leg
 * amount lands Σ pagante ABOVE the nota. Both are the same arithmetic, and the
 * growing one is the worse of the two: `hasUserInteraction` is a LATCH, so no
 * later delivery ever repairs it.
 *
 * ## Degraded means DETAIL LOSS, never an amount-driven collapse
 *
 * "Fewer legs mapped than stored" has two causes, and only one is a loss. A
 * delivery carrying FEWER usable `payment_info` entries than the legs we hold
 * lost detail: it is `degradado` and freezes every stored leg's DATA. A
 * delivery carrying AT LEAST as many entries, which `mapearPagamentosShopee`
 * collapsed to one primary (`motivoColapso`: the entries no longer sum to the
 * buyer leg, or exceed the maximum), lost nothing — the TARGET moved. The
 * worked case (Codex, PR #2224): a FOB order with buyer-paid freight is first
 * imported on provisional money, whose buyer leg is the detail's
 * freight-inclusive `total_amount`, so its two entries fit and two legs are
 * created; the escrow then answers, the buyer leg drops by the freight, and the
 * same entries collapse. Read as a loss, that froze both legs above the new
 * `vNF` — cStat 866 on every later import. Provisional money is still
 * degraded on its own clause (the money is not the escrow's), and a collapse
 * on it never counts as amount-driven.
 *
 * Both comparisons count the legs IN PLAY: a non-primary leg stored
 * `estornado` beside a primary stored outside `estornado`, which the delivery
 * does not map, stays out of Σ whatever the delivery does (the return rule
 * below), so it is no detail to lose. Counted, a superseded sibling froze the
 * primary against every later detail-less delivery, and a moved buyer leg put
 * Σ off `vNF` for ever. A sibling a cancellation took out WITH the primary
 * still counts: it comes back with it.
 *
 * ## The cupom leg: counted APART from the legs, RETIRED rather than frozen
 *
 * The `<order_sn>-desconto` cupom tracks the NF-e floor, which
 * `orderPedidoTx.ts` re-derives on every delivery; the legs track what the
 * buyer paid, which a `payment_info` loss does not move. Counting them together
 * made a delivery on which the floor stopped binding look DEGRADED (one mapped,
 * two owned): the legs froze, the unmapped cupom stayed pagante at its old
 * `valor`, and the pedido's `vNF` went DOWN without it — Σ pagante above the
 * nota, cStat 866, with no later delivery to repair it. So:
 *
 *  - `degradado` compares LEGS with LEGS. A cupom appearing or disappearing
 *    never makes a delivery degraded.
 *  - The cupom's lifecycle follows the MONEY MODEL. "The money answered" =
 *    this delivery maps documents and they are not `dinheiroProvisorio`
 *    (no `pay_time` maps nothing; provisional money never maps a cupom). Unless
 *    the pedido is `congelado`: a MAPPED cupom re-takes its DATA — and is
 *    CREATED when absent — even while the legs are degraded; a stored cupom the
 *    money-answered delivery does NOT map is RETIRED: `estornado`,
 *    `dataCancelamento` fill-once, `valor` and everything else left as stored.
 *    Never deleted and never zeroed (a `vPag` of 0 is nothing to emit), and
 *    only from a status the importer owns, so an operator's off-ladder status
 *    stands and an already-retired one writes nothing. The date is the FIRST
 *    retirement's, kept across a re-activation exactly as a leg keeps its
 *    first reversal (test 16b).
 *  - A cupom stored `estornado` never comes back on the order status ALONE,
 *    or the next `READY_TO_SHIP` would resurrect a retired cupom and re-add
 *    its `valor`: it obeys the ONE return rule below (mapped again on a pedido
 *    no human froze — the floor binds again — or with the PRIMARY leaving
 *    `estornado`). Every other move follows the order like a leg's — out of Σ
 *    (a cancellation), inside it (`aprovado ⇄ em_disputa`), and out of
 *    `em_processo_aprovacao` WITH the legs, since a cupom that is not
 *    `estornado` is not one we retired and the `vNF` still holds it (held
 *    back, it left Σ short: 865, and for ever once a human latched the header).
 *  - Under `congelado` the cupom is a leg like any other — DATA frozen, no
 *    create while a document of ours exists, never retired — and a MAPPED one
 *    obeys the same return rule as an unmapped one: the latched `vNF` was
 *    written without a cupom we retired.
 *  - ⚠️ Three residuals. `estornado` cannot say WHO wrote it, so a cupom (or
 *    a superseded leg) we retired whose ORDER is then cancelled comes back
 *    when the primary does; off the latch the next money-answered delivery
 *    retires it again. A delivery whose escrow answers but whose `pay_time` is
 *    unusable maps nothing here while the pedido still re-derives its money
 *    (`dinheiroShopee.ts`'s `provisorio` needs a usable `pay_time`), so a
 *    floor that stopped binding on it leaves the cupom pagante until the next
 *    delivery with a usable `pay_time` retires it. And a leg set CREATED on
 *    provisional money (its buyer leg freight-inclusive) whose first
 *    escrow-answered delivery has also LOST `payment_info` is detail loss by
 *    the rule above: the legs stay frozen above `vNF` (cStat 866) until a
 *    delivery carrying at least as many entries collapses and retires them
 *    (test 26o). Telling those legs apart needs a stored marker no document
 *    carries — an open decision, not a silent rule.
 *
 * ## The superseded legs: RETIRED like the cupom
 *
 * On an amount-driven collapse whose money answered, on a pedido no human
 * froze, the mapped primary re-takes its DATA (the whole buyer leg) and every
 * stored NON-PRIMARY leg the delivery does not map is superseded: `estornado`
 * through the same ladder as the cupom's retirement (an operator's off-ladder
 * status stands, an already-retired one writes nothing), `dataCancelamento`
 * fill-once, `valor` and every other field kept — never deleted, never zeroed.
 * Under `congelado` nothing is retired and nothing re-taken; on provisional or
 * no-`pay_time` money the legs stay frozen or take the ALWAYS group only.
 *
 * ## One return rule for everything we retire
 *
 * A stored `estornado` cupom or non-primary leg leaves `estornado` only (a)
 * when THIS delivery maps it and re-takes its DATA — a money-answered delivery
 * on a pedido no human froze (and, for a leg, not degraded): the floor binds
 * again, or the combined set fits again — or (b) together with the PRIMARY
 * leaving `estornado` in the same transaction (a reversed cancellation). Both
 * are re-derived from this transaction's read and the order's target. Keyed on
 * the PRIMARY, never on "any leg": a retired sibling must not vouch for the
 * cupom, nor the cupom for a sibling. (a) is an expected path — its own info
 * line and token (`movimentoCupom: 'reativado'`, `pernasReativadas`), never the
 * loud `ressuscitado` meant for a reversed order; under (b) the legs raise that
 * warn and the cupom reports nothing.
 *
 * ## Empty patch means empty write
 *
 * `onPagamentoChanged` ignores only `id` and `ultimaModificacao`, so ANY other
 * re-stamped field files a `historicoDeModificacoes` row on every push. A
 * byte-identical replay therefore has to produce a genuinely EMPTY patch:
 * `marketplace.atualizadoEm` is stamped with the ORDER clock (`watermarkUs`),
 * never with `nowUs`, and `ultimaModificacao` is appended only to an already
 * non-empty patch.
 *
 * ⚠️ There is NO generic deep-equal here — every comparison is field by field and
 * strict, for the #1372 reason: a fold decides which edits count as "no change"
 * and therefore which ones are silently never written.
 *
 * ⚠️ `liquidacao` is the WEEKLY SETTLEMENT SWEEP's top-level field and never
 * appears in a patch this transaction writes, which is what lets the two writers
 * own disjoint masks of one document (`tx.update` masks at a top-level key). The
 * CREATE path writes the schema's own `null` default for it, which is not a
 * collision: the sweep only ever updates a pagamento that already exists.
 *
 * ## Policy, and the two alternatives it is NOT
 *
 * This is `orderPedidoTx.ts`'s policy one collection down — named groups,
 * per-field difference, `tx.update` carrying ONLY the changed keys. It is neither
 * Mercado Livre's `mergePagamentoUpdate` (a whole-document rebuild through
 * `tx.set`, which is exactly why `onPagamentoChanged` needs `ignoreFields` at
 * all) nor Mercado Pago's `GATEWAY_OWNED` inversion (unconditional take-new for a
 * listed set). Only the per-field shape makes `ignorado-sem-mudanca` mean "we
 * wrote nothing".
 *
 * ⚠️ `congelado` means "a pedido whose HEADER a human edited" and is deliberately
 * NOT widened: `savePagamento` does not set `hasUserInteraction`, so an operator
 * editing a pagamento does not freeze it. Widening it would also freeze step 5's
 * pedido groups and trip ML's #669 override.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { coerceToMicros } from '@delfrance/core/datetime';
import { roundReais } from '@delfrance/core/money';
import { pagamentoCollection, pedidoCollection } from '@delfrance/data/admin/collections';
import {
  STATUS_PAGAMENTO,
  sumPagamentosPagos,
  type Cartao,
  type MarketplacePagamento,
  type MarketplacePagamentoTaxas,
  type StatusPagamento,
} from '@delfrance/schemas';

import { totalDaNotaDoPedidoArmazenado } from './dinheiroShopee';
import {
  SUFIXO_CUPOM_SHOPEE,
  idsDePagamentoDaOrdemShopee,
  makePagamentoIdShopee,
} from './orderIds';
import { maiorUs, vazio } from './orderMapping';
import {
  ALVO_STATUS_PAGAMENTO_SHOPEE,
  MAX_PAGAMENTOS_COMBINADOS_SHOPEE,
  MOTIVO_STATUS_PAGAMENTO_SHOPEE,
  statusPagamentoAplicavel,
  type AlvoStatusPagamentoShopee,
  type MotivoStatusPagamentoShopee,
  type PagamentoMapeadoShopee,
  type PagamentosMapeadosShopee,
  type VereditoStatusPagamentoShopee,
} from './pagamentoMapping';

/* -------------------------------------------------------------------------- */
/*                                  outcomes                                   */
/* -------------------------------------------------------------------------- */

export type AcaoPagamentosShopee =
  /** At least one `tx.create`, and no `tx.update`. */
  | 'criado'
  /** At least one `tx.update`. */
  | 'atualizado'
  /** Accepted, re-derived, and every target patch came out EMPTY. */
  | 'ignorado-sem-mudanca'
  /** The stored pedido watermark is NEWER: this payload's money is stale too. */
  | 'ignorado-obsoleto'
  /** The pedido document is not there — a subcollection orphan is refused. */
  | 'ignorado-sem-pedido'
  /** Nothing mapped AND nothing of ours stored: an unpaid order. */
  | 'ignorado-sem-pagamento';

/** Which of the five field groups actually reached a document. */
export type GrupoPagamentoShopee = 'status' | 'tarifas' | 'diario' | 'dados' | 'preencher-uma-vez';

/**
 * What THIS delivery did to the cupom leg's place in Σ pagante — a log token,
 * never a value. Both are status writes on the `<order_sn>-desconto` document.
 */
export type MovimentoCupomShopee =
  /** A money-answered delivery stopped mapping it: `→ estornado`, `valor` kept. */
  | 'retirado'
  /**
   * A delivery mapped it again over a stored `estornado` while the primary did
   * not leave `estornado`: back into Σ because the floor binds again. A
   * reversed ORDER bringing it back with the primary is not this — the legs
   * report that.
   */
  | 'reativado';

/** Named members of {@link MovimentoCupomShopee}. */
export const MOVIMENTO_CUPOM_SHOPEE = {
  retirado: 'retirado',
  reativado: 'reativado',
} as const satisfies Record<string, MovimentoCupomShopee>;

export interface ResultadoPagamentosShopee {
  readonly acao: AcaoPagamentosShopee;
  readonly criados: number;
  readonly atualizados: number;
  /**
   * The documents this transaction WROTE, with the `id` FIELD each carries —
   * `[]` on every `ignorado-*`. What EXISTS is read back from Firestore by the
   * rehearsal CLI; this says what moved.
   */
  readonly docs: readonly { readonly docId: string; readonly idCampo: string }[];
  readonly gruposAplicados: readonly GrupoPagamentoShopee[];
  /** The PRIMARY document's written status, or `null` when none was written. */
  readonly statusEscrito: StatusPagamento | null;
  /** Why the primary's status was not written, or `null` when it was. */
  readonly motivoStatus: MotivoStatusPagamentoShopee | null;
  /**
   * A terminal `estornado` was left on at least one LEG. Logged loudly. ⚠️ The
   * EXPECTED re-activations never set it — the cupom's ({@link movimentoCupom})
   * and a superseded leg's ({@link pernasReativadas}).
   */
  readonly statusRessuscitado: boolean;
  /** The cupom leg retired or re-activated by THIS write, else `null`. */
  readonly movimentoCupom: MovimentoCupomShopee | null;
  /**
   * Non-primary legs THIS write moved to `estornado` because an amount-driven
   * collapse superseded them (the module header). A count, never a value.
   */
  readonly pernasRetiradas: number;
  /**
   * Retired non-primary legs THIS write brought back into Σ because the
   * combined set fits again (mapped, DATA re-taken). A count, never a value.
   */
  readonly pernasReativadas: number;
  /** The pedido's `hasUserInteraction`, re-derived inside the transaction. */
  readonly congelado: boolean;
  /**
   * The pedido document existed when this transaction opened — `false` ONLY on
   * `ignorado-sem-pedido`.
   *
   * ⚠️ It exists so an operator's delete-and-recreate is greppable: read beside
   * the pedido write's own `acao` in the same log line, `acaoPagamentos: 'criado'`
   * over a pedido that came out `ignorado-sem-mudanca`/`atualizado` is a pagamento
   * somebody removed, whereas a FIRST import says `criado` on both.
   */
  readonly pedidoJaExistia: boolean;
  /**
   * Σ pagante `valor` over the WHOLE stored subcollection as it stands AFTER this
   * write — every document, ours or not, because that is exactly the set the NF-e
   * sums (`bundle.ts` → `isPagamentoPagante`). Reais.
   */
  readonly somaPagante: number;
  /**
   * `somaPagante − vNF`, where `vNF` is what the NF-e states for the STORED
   * pedido (`totalDaNotaDoPedidoArmazenado`: the lines, `descontoTotal`, the
   * freight only under CIF), or `null` when a stored line is unreadable.
   * **It must be 0**: on a marketplace `canalDevolveTroco` is false, so an
   * excess is cStat 866 and a shortfall 865. (It is NOT `valorCobrado`, which
   * carries the freight under every modalidade.)
   */
  readonly divergenciaDeSoma: number | null;
}

export interface SalvarPagamentosShopeeArgs {
  readonly pedidoId: string;
  /** The integração document id — HALF of the doc-id preimage. */
  readonly contaId: string;
  readonly orderSn: string;
  /** The ORDER clock of this delivery, µs. Compared with `>=`. */
  readonly watermarkUs: number;
  /** The importer's ONE clock read, µs. Never a clock read in here. */
  readonly nowUs: number;
  readonly mapeados: PagamentosMapeadosShopee;
  /**
   * The ORDER's own status target, from `statusPagamentoDeOrderStatus`.
   *
   * ⚠️ It arrives SEPARATELY from the doc set on purpose: the mapper's creation
   * gate empties `mapeados.docs` whenever `pay_time` is unusable, and a
   * `CANCELLED` re-read whose `pay_time` came back `0` must still move a stored
   * `aprovado` to `estornado`. It is the same value every
   * `docs[i].sempre.alvoStatus` carries — the mapper computes it from the same
   * pure function — and this is the ONE the transaction reads, so the two can
   * never be applied from two places.
   */
  readonly alvoStatus: AlvoStatusPagamentoShopee;
}

/* -------------------------------------------------------------------------- */
/*                          explicit, typed comparisons                        */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ Every comparison below is FIELD BY FIELD and STRICT, deliberately — there is
 * no generic deep-equal in this module, for the reason `orderPedidoTx.ts`'s own
 * header spells out (#1372: a fold decides which edits count as "no change", and
 * its SCOPE is what goes wrong). Writing the fields out makes a new field a
 * compile-time decision instead of something a structural comparison quietly
 * absorbs, and each one is pinned with an equal pair AND a near-miss in
 * `pagamentoTx.test.ts`.
 */
function mesmasTaxas(
  armazenado: Partial<MarketplacePagamentoTaxas> | null | undefined,
  novo: MarketplacePagamentoTaxas | null,
): boolean {
  if (armazenado == null || novo == null) return armazenado == null && novo == null;
  return (
    armazenado.comissao === novo.comissao &&
    armazenado.servico === novo.servico &&
    armazenado.transacaoVendedor === novo.transacaoVendedor &&
    armazenado.campanha === novo.campanha &&
    armazenado.protecaoFrete === novo.protecaoFrete &&
    armazenado.processamento === novo.processamento &&
    armazenado.ajustes === novo.ajustes &&
    armazenado.devolucoes === novo.devolucoes
  );
}

function mesmoMarketplacePagamento(bruto: unknown, novo: MarketplacePagamento): boolean {
  const armazenado = objeto(bruto) as Partial<MarketplacePagamento> | null;
  if (armazenado == null) return false;
  return (
    armazenado.tipo === novo.tipo &&
    armazenado.orderSn === novo.orderSn &&
    armazenado.buyerTotalAmount === novo.buyerTotalAmount &&
    armazenado.escrowAmount === novo.escrowAmount &&
    armazenado.escrowAmountAfterAdjustment === novo.escrowAmountAfterAdjustment &&
    armazenado.tarifasBrutas === novo.tarifasBrutas &&
    armazenado.atualizadoEm === novo.atualizadoEm &&
    mesmasTaxas(armazenado.taxas, novo.taxas)
  );
}

/**
 * The eight `cartaoSchema` fields, strictly.
 *
 * ⚠️ `tpIntegra` is compared too. It is `'2'` (não integrado) on everything this
 * importer builds, but an operator's own card block can hold `'1'`, and a
 * comparison that skipped it would silently leave the stored value standing while
 * reporting the block as identical.
 */
function mesmoCartao(bruto: unknown, novo: Cartao): boolean {
  const armazenado = objeto(bruto) as Partial<Cartao> | null;
  if (armazenado == null) return false;
  return (
    armazenado.tpIntegra === novo.tpIntegra &&
    armazenado.bandeira === novo.bandeira &&
    armazenado.numeroCartao === novo.numeroCartao &&
    armazenado.cAut === novo.cAut &&
    armazenado.cnpj_instituicao === novo.cnpj_instituicao &&
    armazenado.tarifa === novo.tarifa &&
    armazenado.tarifaFixa === novo.tarifaFixa &&
    armazenado.prazoRecebimento === novo.prazoRecebimento
  );
}

function objeto(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function numeroFinito(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The stored `status_pagamento`, read tolerantly — anything else is `null`. */
function statusArmazenado(raw: Record<string, unknown>): StatusPagamento | null {
  const bruto = raw.status_pagamento;
  return typeof bruto === 'number' ? (bruto as StatusPagamento) : null;
}

/* -------------------------------------------------------------------------- */
/*            the status rules of what we retire (cupom, superseded leg)       */
/* -------------------------------------------------------------------------- */

/**
 * A RETIREMENT — the cupom's or a superseded leg's — as a ladder target, so it
 * goes through the SAME {@link statusPagamentoAplicavel} as every other write
 * and inherits its three refusals for free: an already-`estornado` document is
 * `sem-mudanca` (a replay writes nothing), an operator's off-ladder status is
 * `fora-da-escada`, and a `null` or ladder status moves.
 */
const ALVO_RETIRADO: AlvoStatusPagamentoShopee = {
  tipo: ALVO_STATUS_PAGAMENTO_SHOPEE.status,
  status: STATUS_PAGAMENTO.estornado,
};

/** The no-write verdict for a retired document this delivery may not bring back into Σ. */
const RETIRADO_FORA_DA_SOMA: VereditoStatusPagamentoShopee = {
  escrever: false,
  motivo: MOTIVO_STATUS_PAGAMENTO_SHOPEE.retiradoForaDaSoma,
};

/**
 * What the ONE return rule (module header) answers for a stored document of
 * the kind we retire whose order-driven verdict would take it OUT of
 * `estornado`: `segue` — not such a return, or the primary leaves with it (a
 * reversed cancellation), so the verdict stands; `reativa` — this delivery maps
 * it and re-takes its DATA, an expected path; `recusa` — neither, so it stays
 * out of Σ.
 */
type RetornoASoma = 'segue' | 'reativa' | 'recusa';

/**
 * Does this verdict take the document OUT of `estornado`? Read off the
 * ladder's own `ressuscitado` — and every such write lands back in Σ pagante,
 * because `estornado → em_processo_aprovacao` is refused as `regressivo`.
 *
 * ⚠️ Keyed on the stored `estornado`, never on "outside Σ": a cupom at
 * `em_processo_aprovacao` waits for the order's approval WITH the legs, and a
 * rule that held it there while the legs moved left Σ short of a `vNF` that
 * still holds it. Moves inside Σ (`aprovado ⇄ em_disputa`) and out of a
 * legacy `null` are not returns either.
 */
function saiDoEstorno(veredito: VereditoStatusPagamentoShopee): boolean {
  return veredito.escrever && veredito.ressuscitado;
}

/* -------------------------------------------------------------------------- */
/*                              the field groups                               */
/* -------------------------------------------------------------------------- */

/**
 * Which group each written key belongs to — the ONE place the table lives, read
 * by both the create and the update path so the two cannot report differently.
 *
 * ⚠️ Both FILL-ONCE families report as `preencher-uma-vez`: the lifecycle dates
 * (`dataAprovacao`, `dataCancelamento`) and the identity pair (`id`,
 * `dataCadastro`) obey ONE rule — write only while the stored field is
 * {@link vazio} — and differ only in where the value comes from.
 *
 * Keys with no entry (`juros`, `duplicata`, `ultimaModificacao`) report no group:
 * the first two are written once by the create and never patched, and the stamp
 * is not a group.
 */
const GRUPO_POR_CAMPO: Readonly<Record<string, GrupoPagamentoShopee>> = {
  status_pagamento: 'status',
  tarifas: 'tarifas',
  marketplace: 'diario',
  valor: 'dados',
  forma_de_pagamento: 'dados',
  parcelas: 'dados',
  aVista: 'dados',
  descricaoPagamento: 'dados',
  cartao: 'dados',
  id: 'preencher-uma-vez',
  dataCadastro: 'preencher-uma-vez',
  dataAprovacao: 'preencher-uma-vez',
  dataCancelamento: 'preencher-uma-vez',
};

function registrarGrupos(chaves: readonly string[], destino: Set<GrupoPagamentoShopee>): void {
  for (const chave of chaves) {
    const grupo = GRUPO_POR_CAMPO[chave];
    if (grupo !== undefined) destino.add(grupo);
  }
}

/**
 * What {@link construirPatch} needs from the transaction's own reads.
 *
 * ⚠️ The ladder TARGET is deliberately absent: both builders take the already
 * decided `veredito` as an argument, so the target reaches them through exactly
 * one path. A copy here would read as if the patch builder still re-consulted
 * the ladder, and nothing would fail when the two disagreed (neither
 * `noUnusedLocals` nor `@typescript-eslint/no-unused-vars` sees an unread
 * interface member).
 */
interface ContextoPatch {
  readonly watermarkUs: number;
  readonly congelado: boolean;
  readonly degradado: boolean;
}

/**
 * The patch for ONE stored document, built against the RAW snapshot.
 *
 * `mapeado === null` is the document of ours this delivery did NOT map — the
 * sibling a degraded delivery left behind, every document of ours when the
 * creation gate emptied the mapped set, or the cupom / superseded leg a
 * money-answered delivery retires (its verdict then targets `estornado`). It still takes the ALWAYS group's
 * `status_pagamento` and the `dataCancelamento` that goes with it; it takes
 * nothing else, because `tarifas` and `marketplace` describe the ORDER and live
 * on the primary, and re-taking the DATA group from a leg this payload no longer
 * carries is exactly the double-count the whole-collection read exists to stop.
 */
function construirPatch(
  raw: Record<string, unknown>,
  mapeado: PagamentoMapeadoShopee | null,
  ctx: ContextoPatch,
  veredito: VereditoStatusPagamentoShopee,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  /* -- ALWAYS: the marketplace's lifecycle and its own money ----------------- */
  if (veredito.escrever && raw.status_pagamento !== veredito.status) {
    patch.status_pagamento = veredito.status;
  }
  if (mapeado !== null) {
    // ⚠️ `undefined` means "we did not learn it", so the key is OMITTED and a fee
    // a richer earlier delivery already stored survives. Only a CREATE ever
    // writes `tarifas: null`.
    if (mapeado.sempre.tarifas !== undefined && raw.tarifas !== mapeado.sempre.tarifas) {
      patch.tarifas = mapeado.sempre.tarifas;
    }
    if (
      mapeado.sempre.marketplace !== undefined &&
      !mesmoMarketplacePagamento(raw.marketplace, mapeado.sempre.marketplace)
    ) {
      patch.marketplace = mapeado.sempre.marketplace;
    }
  }

  /* -- FILL-ONCE (lifecycle) ------------------------------------------------- */
  if (mapeado !== null && mapeado.datas.dataAprovacao !== undefined && vazio(raw.dataAprovacao)) {
    patch.dataAprovacao = mapeado.datas.dataAprovacao;
  }
  if (
    veredito.escrever &&
    veredito.status === STATUS_PAGAMENTO.estornado &&
    vazio(raw.dataCancelamento)
  ) {
    // The ORDER clock of the delivery that first reversed it — never `nowUs`,
    // which would move on every replay, and fill-once so a second CANCELLED
    // delivery keeps the FIRST reversal's date.
    patch.dataCancelamento = ctx.watermarkUs;
  }

  if (mapeado === null) return patch;

  /* -- FILL-ONCE (identity) -------------------------------------------------- */
  if (vazio(raw.id)) patch.id = mapeado.preencherUmaVez.id;
  if (vazio(raw.dataCadastro)) patch.dataCadastro = mapeado.preencherUmaVez.dataCadastro;

  /* -- DATA: frozen by an operator edit OR by a degraded delivery ------------ */
  if (ctx.congelado || ctx.degradado) return patch;

  if (raw.valor !== mapeado.dados.valor) patch.valor = mapeado.dados.valor;
  if (raw.forma_de_pagamento !== mapeado.dados.forma_de_pagamento) {
    patch.forma_de_pagamento = mapeado.dados.forma_de_pagamento;
  }
  if (raw.parcelas !== mapeado.dados.parcelas) patch.parcelas = mapeado.dados.parcelas;
  if (raw.aVista !== mapeado.dados.aVista) patch.aVista = mapeado.dados.aVista;
  if (raw.descricaoPagamento !== mapeado.dados.descricaoPagamento) {
    patch.descricaoPagamento = mapeado.dados.descricaoPagamento;
  }
  // ⚠️ Take-new only when LEARNED, and NEVER cleared: a delivery carrying no
  // `payment_info` supplies `undefined` (whether Shopee keeps sending the block
  // past READY_TO_SHIP is settle-live register item 22, still open), and a
  // `cartao: null` there would destroy the block PIX needs — SEFAZ rejects a PIX
  // leg with no `<card>` as cStat 391, on a pedido still awaiting emission.
  if (mapeado.dados.cartao !== undefined && !mesmoCartao(raw.cartao, mapeado.dados.cartao)) {
    patch.cartao = mapeado.dados.cartao;
  }
  return patch;
}

/** The full body a CREATE writes. A create has nothing to erase. */
function corpoDeCriacao(
  mapeado: PagamentoMapeadoShopee,
  ctx: ContextoPatch,
  veredito: VereditoStatusPagamentoShopee,
): Record<string, unknown> {
  const status = veredito.escrever ? veredito.status : null;
  return {
    id: mapeado.preencherUmaVez.id,
    forma_de_pagamento: mapeado.dados.forma_de_pagamento,
    status_pagamento: status,
    valor: mapeado.dados.valor,
    parcelas: mapeado.dados.parcelas,
    aVista: mapeado.dados.aVista,
    descricaoPagamento: mapeado.dados.descricaoPagamento,
    // Fiscally inert and never part of `valor`; `duplicata` drives the NF-e's
    // `indPag` together with `aVista` and is always a marketplace's "à vista".
    juros: null,
    duplicata: false,
    // ⚠️ The ONE place a `null` fee is written: there is no stored value to erase.
    tarifas: mapeado.sempre.tarifas ?? null,
    ...(mapeado.sempre.marketplace !== undefined
      ? { marketplace: mapeado.sempre.marketplace }
      : {}),
    ...(mapeado.dados.cartao !== undefined ? { cartao: mapeado.dados.cartao } : {}),
    ...(mapeado.datas.dataAprovacao !== undefined
      ? { dataAprovacao: mapeado.datas.dataAprovacao }
      : {}),
    ...(status === STATUS_PAGAMENTO.estornado ? { dataCancelamento: ctx.watermarkUs } : {}),
    dataCadastro: mapeado.preencherUmaVez.dataCadastro,
    ultimaModificacao: mapeado.preencherUmaVez.dataCadastro,
  };
}

/* -------------------------------------------------------------------------- */
/*                               the transaction                               */
/* -------------------------------------------------------------------------- */

/** One stored pagamento as it will stand after this write — for the Σ diagnostic. */
interface LinhaParaSoma {
  valor: number;
  status_pagamento: number | null;
}

function resultadoSemEscrita(
  acao: AcaoPagamentosShopee,
  extra: Pick<ResultadoPagamentosShopee, 'congelado' | 'pedidoJaExistia'> &
    Partial<Pick<ResultadoPagamentosShopee, 'somaPagante' | 'divergenciaDeSoma'>>,
): ResultadoPagamentosShopee {
  return {
    acao,
    criados: 0,
    atualizados: 0,
    docs: [],
    gruposAplicados: [],
    statusEscrito: null,
    motivoStatus: null,
    statusRessuscitado: false,
    movimentoCupom: null,
    pernasRetiradas: 0,
    pernasReativadas: 0,
    congelado: extra.congelado,
    pedidoJaExistia: extra.pedidoJaExistia,
    somaPagante: extra.somaPagante ?? 0,
    divergenciaDeSoma: extra.divergenciaDeSoma ?? null,
  };
}

export async function salvarPagamentosShopee(
  db: Firestore,
  args: SalvarPagamentosShopeeArgs,
): Promise<ResultadoPagamentosShopee> {
  const { pedidoId, contaId, orderSn, watermarkUs, nowUs, mapeados, alvoStatus } = args;

  return db.runTransaction(async (tx: Transaction) => {
    /* ------------------------- READ 1 — the pedido -------------------------- */
    const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);
    const pedidoSnap = await tx.get(pedidoRef);
    if (!pedidoSnap.exists) {
      console.warn('[shopee/pagamentos] pedido inexistente — nenhum pagamento gravado', {
        orderSn,
        pedidoId,
      });
      return resultadoSemEscrita('ignorado-sem-pedido', {
        congelado: false,
        pedidoJaExistia: false,
      });
    }
    const pedidoRaw = (pedidoSnap.data() ?? {}) as Record<string, unknown>;
    const congelado = pedidoRaw.hasUserInteraction === true;
    // What the NF-e will state for the pedido as it is STORED — the Σ diagnostic's
    // reference, through the shared totals (the freight only under CIF).
    const totalDaNotaPedido = totalDaNotaDoPedidoArmazenado(pedidoRaw).totalDaNota;

    // The watermark gate. `coerceToMicros` on the STORED side ONLY — the legacy
    // corpus holds ms ints and ISO strings there, and the incoming side is
    // already µs from `microsDeSegundosShopee`.
    const armazenadoUs = coerceToMicros(pedidoRaw.lastMarketplaceUpdate);
    if (armazenadoUs != null && watermarkUs < armazenadoUs) {
      // eslint-disable-next-line no-console -- one line per dropped redelivery; ids and numbers only
      console.info('[shopee/pagamentos] payload obsoleto descartado', {
        orderSn,
        pedidoId,
        armazenadoUs,
        recebidoUs: watermarkUs,
      });
      return resultadoSemEscrita('ignorado-obsoleto', { congelado, pedidoJaExistia: true });
    }

    /* ------------- READ 2 — the WHOLE pagamentos subcollection -------------- */
    const colRef = pagamentoCollection.ref(db, { pedidoId });
    const colSnap = await tx.get(colRef);
    const armazenados = colSnap.docs.map((d) => ({
      id: d.id,
      raw: (d.data() ?? {}) as Record<string, unknown>,
    }));

    // Ownership by RECOMPUTED doc id. The reachable index set is exactly
    // `[0, MAX)`: a combined payment of MAX legs occupies indices 0…MAX-1, and
    // anything above MAX collapses to the single primary — plus the cupom leg.
    const idsDeOwnership = idsDePagamentoDaOrdemShopee(
      contaId,
      orderSn,
      MAX_PAGAMENTOS_COMBINADOS_SHOPEE,
    );
    const nossos = armazenados.filter((d) => idsDeOwnership.has(d.id));

    if (mapeados.docs.length === 0 && nossos.length === 0) {
      return resultadoSemEscrita('ignorado-sem-pagamento', {
        congelado,
        pedidoJaExistia: true,
        somaPagante: sumPagamentosPagos(armazenados.map((d) => linhaDeSoma(d.raw))),
        divergenciaDeSoma: null,
      });
    }

    /* ------------------- the cupom leg, counted APART ----------------------- */
    // The legs and the cupom answer to different things (the module header):
    // the legs to what the buyer paid, the cupom to the floor. Every count below
    // is over LEGS; the cupom has its own rules.
    const idCupom = makePagamentoIdShopee(contaId, orderSn, SUFIXO_CUPOM_SHOPEE);
    const pernasNossas = nossos.filter((d) => d.id !== idCupom);
    const pernasMapeadas = mapeados.docs.filter((m) => m.docId !== idCupom).length;
    // "The money answered": an escrow-backed delivery. No usable `pay_time` maps
    // NOTHING, and provisional money never maps a cupom, so neither may decide
    // that the floor stopped binding.
    const dinheiroRespondeu = mapeados.docs.length > 0 && !mapeados.dinheiroProvisorio;
    // The PRIMARY leaving `estornado` in THIS transaction — a reversed
    // cancellation. Re-derived from this transaction's read and the order's
    // target: exactly the verdict `avaliar` reaches for it, mapped or not. It
    // is the ONE thing that lets a document of the kind we retire (the cupom,
    // a superseded leg) come back with the order that took them out together.
    //
    // ⚠️ The PRIMARY, never "any leg": a superseded sibling is itself a
    // document we retire, so letting it vouch would let one retirement undo
    // another (test 26g).
    //
    // ⚠️ "Leaves `estornado`", never "enters Σ": a primary moving from
    // `em_processo_aprovacao` into Σ is the order getting PAID, which says
    // nothing about the floor, so a cupom we retired while it waited must stay
    // out (test 25q).
    const idPrimario = makePagamentoIdShopee(contaId, orderSn);
    const primarioArmazenado = pernasNossas.find((d) => d.id === idPrimario);
    const primarioSaiDoEstorno =
      primarioArmazenado !== undefined &&
      saiDoEstorno(statusPagamentoAplicavel(statusArmazenado(primarioArmazenado.raw), alvoStatus));

    /* ----------------------- the legs still IN PLAY ------------------------- */
    // A non-primary leg stored `estornado` beside a primary stored OUTSIDE
    // `estornado`, which this delivery does not map, stays out of Σ whatever
    // this delivery does: unmapped, the ONE return rule lets it back only with
    // the primary leaving `estornado`, and the primary is not there. It is no
    // detail this delivery could have lost, so the degraded count leaves it
    // out — counted, a superseded sibling froze an already-correct primary
    // against every later detail-less delivery, and a moved buyer leg then put
    // Σ off `vNF` for ever (test 26k).
    //
    // ⚠️ Keyed on the primary's STORED status. A sibling the ORDER took out
    // (a cancellation: the primary is `estornado` too) still counts: it comes
    // back with the primary, so re-taking the primary's whole buyer leg while
    // the order is cancelled would double it on the un-cancel (test 26m).
    const mapeadosPorId = new Set(mapeados.docs.map((m) => m.docId));
    const primarioForaDoEstorno =
      primarioArmazenado !== undefined &&
      statusArmazenado(primarioArmazenado.raw) !== STATUS_PAGAMENTO.estornado;
    const pernasEmJogo = pernasNossas.filter(
      (d) =>
        !(
          primarioForaDoEstorno &&
          d.id !== idPrimario &&
          !mapeadosPorId.has(d.id) &&
          statusArmazenado(d.raw) === STATUS_PAGAMENTO.estornado
        ),
    );

    /* -------------------------- the degraded delivery ----------------------- */
    // ⚠️ A later delivery that LOST detail never deletes, never neutralises and
    // never re-takes the primary's `valor`: "one leg now" is a payload that lost
    // detail, not a payment that changed — whether `payment_info` survives past
    // READY_TO_SHIP is settle-live register item 22 and is NOT yet known, so the
    // shrink has to be read as detail loss either way. Re-taking would
    // double-count against the siblings.
    //
    // ⚠️ DETAIL LOSS, never an AMOUNT-DRIVEN COLLAPSE (the module header). A
    // delivery carrying at least as many usable `payment_info` entries as the
    // legs in play, which the mapper collapsed to one primary by rule
    // (`motivoColapso`), lost nothing: the buyer leg moved under the same
    // entries — above all provisional money's freight-inclusive total giving
    // way to the escrow's (Codex, PR #2224). Read as a loss, it froze every
    // stored leg above the new `vNF`: cStat 866 for ever. Never on provisional
    // money, which its own clause below freezes anyway.
    //
    // ⚠️ RELATIVE to what we OWN, never to the number two. A shrink from N legs
    // to any count in `[2, N)` is the same defect by a different route: the
    // mapped legs re-take their own `payment_amount` (which sums to
    // `valorCobrado` by the combined gate) while the leg that was NOT mapped
    // keeps the `valor` a richer delivery gave it, and Σ pagante exceeds the
    // nota by exactly that orphan — which stays pagante, so the NF-e sums it.
    // A delivery that maps NOTHING (the creation gate, an unusable `pay_time`)
    // is not degraded: there is no DATA group to run and nothing to freeze.
    //
    // ⚠️ LEGS against LEGS, never documents against documents. The cupom is not
    // a leg: a delivery on which the floor stopped binding maps one document
    // where two are stored, and reading THAT as a shrink froze the legs and
    // left the unmapped cupom pagante while the pedido's `vNF` went down
    // without it — cStat 866 for ever (PR #2224). The cupom's own lifecycle is
    // below.
    //
    // ⚠️ PROVISIONAL money is the same defect by a third route: a paid delivery
    // whose escrow did not answer maps the buyer leg from the detail
    // (`dinheiroShopee.ts`), and re-taking it over documents an earlier,
    // escrow-backed delivery wrote would move Σ pagante off the stored lines.
    // Frozen exactly like a shrink — and only over documents of ours, so a
    // first delivery still creates its set.
    const colapsoPorValor =
      !mapeados.dinheiroProvisorio &&
      mapeados.diagnosticos.motivoColapso !== null &&
      mapeados.diagnosticos.entradasPaymentInfo >= pernasEmJogo.length;
    const perdeuDetalhe =
      pernasMapeadas > 0 && pernasMapeadas < pernasEmJogo.length && !colapsoPorValor;
    const degradado = perdeuDetalhe || (mapeados.dinheiroProvisorio && nossos.length > 0);
    if (degradado) {
      // eslint-disable-next-line no-console -- counts only; the fact that a delivery lost detail is the finding
      console.info('[shopee/pagamentos] entrega degradada — grupo `dados` congelado', {
        orderSn,
        pedidoId,
        pernasArmazenadas: pernasNossas.length,
        pernasEmJogo: pernasEmJogo.length,
        pernasRecebidas: pernasMapeadas,
        dinheiroProvisorio: mapeados.dinheiroProvisorio,
      });
    }

    /* ---------------- the superseded legs and the return rule --------------- */
    // An amount-driven collapse whose money answered, on a pedido no human
    // froze: the primary re-takes the whole buyer leg (DATA runs — not
    // degraded), so every stored NON-PRIMARY leg it does not map is superseded
    // and RETIRED like the cupom (module header). A `tx.update` on a document
    // this transaction's whole-subcollection read returned, decided from that
    // read — nothing captured outside the callback, no second transaction.
    const retiraPernasSuperadas = colapsoPorValor && dinheiroRespondeu && !congelado;
    // A LEG's DATA is re-taken on this delivery: the money answered, no human
    // froze the pedido and nothing was lost. The condition under which a
    // MAPPED retired leg may come back (the return rule's arm (a)).
    const dadosDasPernasRodam = dinheiroRespondeu && !congelado && !degradado;
    /**
     * The ONE return rule (module header) for a stored document of the kind we
     * retire — the cupom or a non-primary leg — given its order-driven verdict
     * and whether THIS delivery maps it and re-takes its DATA.
     */
    const retornoASoma = (
      veredito: VereditoStatusPagamentoShopee,
      dadosRetomados: boolean,
    ): RetornoASoma => {
      if (!saiDoEstorno(veredito) || primarioSaiDoEstorno) return 'segue';
      return dadosRetomados ? 'reativa' : 'recusa';
    };

    /* ------------------- the doc SET grows while DATA is frozen ------------- */
    // ⚠️ The MIRROR image of `degradado`, and the same arithmetic. While the DATA
    // group is frozen every stored document keeps the `valor` a poorer earlier
    // delivery gave it — above all a primary that stands at the WHOLE
    // `valorCobrado` because that delivery carried no `payment_info` at all — so
    // ADDING a sibling at its own leg amount puts Σ pagante ABOVE the nota. On a
    // marketplace `canalDevolveTroco` is false, so that is cStat 866 for ever,
    // and `hasUserInteraction` is a LATCH: no later delivery ever re-takes the
    // primary's `valor` to repair it. `degradado` alone guards only the
    // SHRINKING direction, which is why this is a second condition and not a
    // wider one.
    //
    // The gate is deliberately narrow: it needs at least one document of ours
    // already stored. A pedido a human touched before its FIRST pagamento
    // arrived still gets the whole set created (Σ is established by those
    // creates, not endangered by them), and so does the operator-deleted doc of
    // test 21 — nothing of ours is left to disagree with.
    //
    // ⚠️ The CUPOM is gated by `congelado` alone. It tracks the floor, which
    // `orderPedidoTx.ts` keeps re-deriving on a pedido no human froze, so a
    // degraded LEG set is no reason to withhold it: the legs' frozen sum is the
    // buyer leg, which a `payment_info` loss does not move, and the cupom is
    // what the floor adds on top.
    const conjuntoCongelado = (congelado || degradado) && nossos.length > 0;
    const cupomCongelado = congelado && nossos.length > 0;
    let naoCriados = 0;

    const ctx: ContextoPatch = { watermarkUs, congelado, degradado };
    // The cupom's DATA is frozen by `congelado` only — never by the legs.
    const ctxCupom: ContextoPatch = { watermarkUs, congelado, degradado: false };
    const porId = new Map(nossos.map((d) => [d.id, d.raw]));
    const grupos = new Set<GrupoPagamentoShopee>();
    const escritos: { docId: string; idCampo: string }[] = [];
    // The projected post-write state, keyed by doc id, seeded with what is stored
    // (every document, ours or not — the NF-e sums the whole subcollection).
    const projecao = new Map<string, LinhaParaSoma>(
      armazenados.map((d) => [d.id, linhaDeSoma(d.raw)]),
    );
    let criados = 0;
    let atualizados = 0;
    let statusEscrito: StatusPagamento | null = null;
    let motivoStatus: MotivoStatusPagamentoShopee | null = null;
    let statusRessuscitado = false;
    let movimentoCupom: MovimentoCupomShopee | null = null;
    let pernasRetiradas = 0;
    let pernasReativadas = 0;
    let vereditoDoPrimario: VereditoStatusPagamentoShopee | null = null;

    /** A LEG leaving `estornado` because the ORDER came back — reported loudly. */
    const reportarRessuscitado = (
      veredito: VereditoStatusPagamentoShopee,
    ): VereditoStatusPagamentoShopee => {
      if (veredito.escrever && veredito.ressuscitado) {
        statusRessuscitado = true;
        console.warn(
          '[shopee/pagamentos] status ressuscitado — um pagamento estornado voltou a valer',
          { orderSn, pedidoId, para: veredito.status },
        );
      }
      return veredito;
    };

    /** The PRIMARY's verdict: the order's target through the ladder. */
    const avaliar = (raw: Record<string, unknown> | null): VereditoStatusPagamentoShopee =>
      reportarRessuscitado(
        statusPagamentoAplicavel(raw === null ? null : statusArmazenado(raw), alvoStatus),
      );

    /**
     * A NON-PRIMARY leg's verdict. A stored one this delivery does NOT map, on
     * an amount-driven collapse that supersedes it ({@link retiraPernasSuperadas}),
     * is RETIRED through {@link ALVO_RETIRADO}. Otherwise the order's target,
     * under the ONE return rule: a retired leg comes back with the primary (the
     * order's warn), when this delivery maps it and re-takes its DATA (the
     * combined set fits again: its own info line, never the warn), and never
     * otherwise — or the next provisional or no-`pay_time` `READY_TO_SHIP`
     * would resurrect it and re-add its `valor` above the nota.
     */
    const avaliarPernaSecundaria = (
      raw: Record<string, unknown> | null,
      mapeada: boolean,
    ): VereditoStatusPagamentoShopee => {
      if (raw !== null && !mapeada && retiraPernasSuperadas) {
        const veredito = statusPagamentoAplicavel(statusArmazenado(raw), ALVO_RETIRADO);
        if (veredito.escrever) pernasRetiradas += 1;
        return veredito;
      }
      const veredito = statusPagamentoAplicavel(
        raw === null ? null : statusArmazenado(raw),
        alvoStatus,
      );
      const retorno = retornoASoma(veredito, mapeada && dadosDasPernasRodam);
      if (retorno === 'segue') return reportarRessuscitado(veredito);
      if (retorno === 'recusa') return RETIRADO_FORA_DA_SOMA;
      pernasReativadas += 1;
      // eslint-disable-next-line no-console -- ids only; the combined set fitting again is the finding
      console.info(
        '[shopee/pagamentos] perna de pagamento reativada — o pagamento combinado voltou a fechar',
        { orderSn, pedidoId },
      );
      return veredito;
    };

    /**
     * The MAPPED cupom's verdict: the order's target, exactly like a leg —
     * re-activation over a stored `estornado` included, because the floor binds
     * again — under the ONE return rule: its DATA is re-taken unless the pedido
     * is `congelado`, so under the latch a return the primary does not share is
     * a cupom WE retired, and the latched `vNF` was written without it.
     *
     * ⚠️ Its re-activation is EXPECTED (the floor moves with the shipping cost),
     * so it logs its own info line and never sets {@link statusRessuscitado}.
     * A return the primary SHARES is the ORDER coming back: the legs raise that
     * warn themselves, and the cupom reports nothing — the floor did not move.
     */
    const avaliarCupomMapeado = (
      raw: Record<string, unknown> | null,
    ): VereditoStatusPagamentoShopee => {
      const veredito = statusPagamentoAplicavel(
        raw === null ? null : statusArmazenado(raw),
        alvoStatus,
      );
      const retorno = retornoASoma(veredito, !congelado);
      if (retorno === 'segue') return veredito;
      if (retorno === 'recusa') return RETIRADO_FORA_DA_SOMA;
      movimentoCupom = MOVIMENTO_CUPOM_SHOPEE.reativado;
      // eslint-disable-next-line no-console -- ids only; the floor binding again is the finding
      console.info('[shopee/pagamentos] cupom de desconto reativado — o piso voltou a valer', {
        orderSn,
        pedidoId,
      });
      return veredito;
    };

    /**
     * The verdict for a STORED cupom this delivery does NOT map.
     *
     * A money-answered delivery on a pedido no human froze RETIRES it — the
     * floor no longer binds, and `orderPedidoTx.ts` has already taken `vNF` down
     * without it. Any other delivery (no `pay_time`, provisional money,
     * `congelado`) says nothing about the floor: the cupom takes the order's
     * target like a leg, except a return from `estornado` the primary does not
     * share (the ONE return rule; unmapped, its DATA is never re-taken) — or
     * the next `READY_TO_SHIP` would resurrect a retired cupom and re-add its
     * `valor`.
     */
    const avaliarCupomNaoMapeado = (
      raw: Record<string, unknown>,
    ): VereditoStatusPagamentoShopee => {
      const armazenado = statusArmazenado(raw);
      if (dinheiroRespondeu && !congelado) {
        const veredito = statusPagamentoAplicavel(armazenado, ALVO_RETIRADO);
        if (veredito.escrever) {
          movimentoCupom = MOVIMENTO_CUPOM_SHOPEE.retirado;
          // eslint-disable-next-line no-console -- ids only; the floor ceasing to bind is the finding
          console.info('[shopee/pagamentos] cupom de desconto retirado — o piso deixou de valer', {
            orderSn,
            pedidoId,
          });
        }
        return veredito;
      }
      const veredito = statusPagamentoAplicavel(armazenado, alvoStatus);
      return retornoASoma(veredito, false) === 'recusa' ? RETIRADO_FORA_DA_SOMA : veredito;
    };

    /* ------------------------- the mapped documents ------------------------- */
    for (const mapeado of mapeados.docs) {
      const ehCupom = mapeado.docId === idCupom;
      const ref = pagamentoCollection.docRef(db, { pedidoId }, mapeado.docId);
      const raw = porId.get(mapeado.docId);

      // ⚠️ Skipped BEFORE `avaliar`: a document this delivery does not create has
      // no status written and must not report one (nor raise a `ressuscitado`
      // warn about a document that does not exist).
      if (raw === undefined && (ehCupom ? cupomCongelado : conjuntoCongelado)) {
        naoCriados += 1;
        continue;
      }

      const ehPrimario = mapeado.docId === idPrimario;
      const veredito = ehCupom
        ? avaliarCupomMapeado(raw ?? null)
        : ehPrimario
          ? avaliar(raw ?? null)
          : avaliarPernaSecundaria(raw ?? null, true);
      if (ehPrimario) vereditoDoPrimario = veredito;
      const ctxDoDoc = ehCupom ? ctxCupom : ctx;

      if (raw === undefined) {
        const corpo = corpoDeCriacao(mapeado, ctxDoDoc, veredito);
        // `tx.create`, never `tx.set`: OCC turns a concurrent create into an
        // abort-and-retry that falls through to the update path, and if the
        // engine ever failed to detect it, `create` fails loudly instead of
        // clobbering the winner.
        tx.create(ref, pagamentoCollection.parse(corpo));
        registrarGrupos(Object.keys(corpo), grupos);
        escritos.push({ docId: mapeado.docId, idCampo: mapeado.preencherUmaVez.id });
        projecao.set(mapeado.docId, {
          valor: mapeado.dados.valor,
          status_pagamento: veredito.escrever ? veredito.status : null,
        });
        criados += 1;
        continue;
      }

      const patch = construirPatch(raw, mapeado, ctxDoDoc, veredito);
      if (Object.keys(patch).length === 0) continue;
      // Monotonic and never null: `parseMergePatch` keeps a null and would erase
      // the stamp. Appended ONLY here, so an empty patch stays empty.
      patch.ultimaModificacao = maiorUs(coerceToMicros(raw.ultimaModificacao), nowUs);
      tx.update(ref, pagamentoCollection.parseMerge(patch));
      registrarGrupos(Object.keys(patch), grupos);
      escritos.push({
        docId: mapeado.docId,
        idCampo: typeof raw.id === 'string' && raw.id !== '' ? raw.id : mapeado.preencherUmaVez.id,
      });
      projecao.set(mapeado.docId, aplicarNaProjecao(projecao.get(mapeado.docId), patch));
      atualizados += 1;
    }

    if (naoCriados > 0) {
      // eslint-disable-next-line no-console -- counts only; the fact that a delivery could not GROW the set is the finding
      console.info('[shopee/pagamentos] conjunto congelado — documento novo NÃO criado', {
        orderSn,
        pedidoId,
        armazenados: nossos.length,
        recebidos: mapeados.docs.length,
        naoCriados,
        congelado,
        degradado,
      });
    }

    /* -- documents of ours this delivery did NOT map (degraded / gated / the -- */
    /* -- cupom whose floor stopped binding / the legs a collapse superseded) -- */
    // ⚠️ Every retirement is a `tx.update` on a document THIS transaction's
    // whole-subcollection read returned, decided from that read — nothing
    // captured outside the callback, no second transaction.
    for (const { id, raw } of nossos) {
      if (mapeadosPorId.has(id)) continue;
      const veredito =
        id === idCupom
          ? avaliarCupomNaoMapeado(raw)
          : id === idPrimario
            ? avaliar(raw)
            : avaliarPernaSecundaria(raw, false);
      if (vereditoDoPrimario === null && id === idPrimario) vereditoDoPrimario = veredito;
      const patch = construirPatch(raw, null, ctx, veredito);
      if (Object.keys(patch).length === 0) continue;
      patch.ultimaModificacao = maiorUs(coerceToMicros(raw.ultimaModificacao), nowUs);
      tx.update(
        pagamentoCollection.docRef(db, { pedidoId }, id),
        pagamentoCollection.parseMerge(patch),
      );
      registrarGrupos(Object.keys(patch), grupos);
      escritos.push({ docId: id, idCampo: typeof raw.id === 'string' ? raw.id : '' });
      projecao.set(id, aplicarNaProjecao(projecao.get(id), patch));
      atualizados += 1;
    }

    if (pernasRetiradas > 0) {
      // eslint-disable-next-line no-console -- counts and a closed token only; the target moving under the same entries is the finding
      console.info(
        '[shopee/pagamentos] pernas superadas retiradas — o combinado colapsou por valor',
        {
          orderSn,
          pedidoId,
          pernasArmazenadas: pernasNossas.length,
          pernasRetiradas,
          entradasPaymentInfo: mapeados.diagnosticos.entradasPaymentInfo,
          motivoColapso: mapeados.diagnosticos.motivoColapso,
        },
      );
    }

    if (vereditoDoPrimario !== null) {
      statusEscrito = vereditoDoPrimario.escrever ? vereditoDoPrimario.status : null;
      motivoStatus = vereditoDoPrimario.escrever ? null : vereditoDoPrimario.motivo;
    }

    const somaPagante = sumPagamentosPagos([...projecao.values()]);
    const divergenciaDeSoma =
      totalDaNotaPedido == null ? null : roundReais(somaPagante - totalDaNotaPedido);

    const acao: AcaoPagamentosShopee =
      atualizados > 0 ? 'atualizado' : criados > 0 ? 'criado' : 'ignorado-sem-mudanca';

    return {
      acao,
      criados,
      atualizados,
      docs: escritos,
      gruposAplicados: [...grupos],
      statusEscrito,
      motivoStatus,
      statusRessuscitado,
      movimentoCupom,
      pernasRetiradas,
      pernasReativadas,
      congelado,
      pedidoJaExistia: true,
      somaPagante,
      divergenciaDeSoma,
    } satisfies ResultadoPagamentosShopee;
  });
}

/** One stored document reduced to what `sumPagamentosPagos` reads. */
function linhaDeSoma(raw: Record<string, unknown>): LinhaParaSoma {
  return { valor: numeroFinito(raw.valor) ?? 0, status_pagamento: statusArmazenado(raw) };
}

/** The projected row after a patch — only the two fields the Σ reads. */
function aplicarNaProjecao(
  anterior: LinhaParaSoma | undefined,
  patch: Record<string, unknown>,
): LinhaParaSoma {
  const base = anterior ?? { valor: 0, status_pagamento: null };
  return {
    valor: 'valor' in patch ? (numeroFinito(patch.valor) ?? base.valor) : base.valor,
    status_pagamento:
      'status_pagamento' in patch
        ? (numeroFinito(patch.status_pagamento) ?? null)
        : base.status_pagamento,
  };
}
