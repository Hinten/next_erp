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
 * Which stored documents are OURS is decided by RECOMPUTING
 * `makePagamentoIdShopee(contaId, orderSn, sufixoPagamentoShopee(i))` — never by
 * the `id` FIELD, which rides `...base` through the operator's form and is
 * therefore reachable by a hand edit. That is also what keeps the legacy
 * `<order_sn>-desconto` sibling out of this transaction entirely: it is read as
 * part of the Σ diagnostic and patched by nothing.
 *
 * ## Nothing is ever deleted, and while DATA is frozen nothing is ADDED either
 *
 * A pagamento the operator removed is RECREATED on the next delivery (the money
 * really moved), and a surplus document from a richer earlier delivery keeps its
 * own `valor`. Deleting would be the one irreversible thing this path could do.
 *
 * ⚠️ The freeze has TWO directions and they cost the same. A delivery that maps
 * FEWER documents than we own is `degradado` and must not re-take the primary's
 * `valor`; a delivery that maps MORE of them while the DATA group is frozen must
 * not CREATE the extra ones — the stored primary is still standing at whatever a
 * poorer earlier delivery gave it (often the whole `valorCobrado`, because that
 * delivery carried no `payment_info`), so a new sibling at its own leg amount
 * lands Σ pagante ABOVE the nota. Both are the same arithmetic, and the growing
 * one is the worse of the two: `hasUserInteraction` is a LATCH, so no later
 * delivery ever repairs it.
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

import { makePagamentoIdShopee, sufixoPagamentoShopee } from './orderIds';
import { maiorUs, vazio } from './orderMapping';
import {
  MAX_PAGAMENTOS_COMBINADOS_SHOPEE,
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
  /** A terminal `estornado` was left on at least one document. Logged loudly. */
  readonly statusRessuscitado: boolean;
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
   * `somaPagante − pedido.valorCobrado`, or `null` when the stored pedido carries
   * no usable figure. **It must be 0**: on a marketplace `canalDevolveTroco` is
   * false, so an excess is cStat 866 and a shortfall 865.
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
 * sibling a degraded delivery left behind, or every document of ours when the
 * creation gate emptied the mapped set. It still takes the ALWAYS group's
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
    const valorCobradoPedido = numeroFinito(pedidoRaw.valorCobrado);

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
    // anything above MAX collapses to the single primary.
    const idsDeOwnership = new Set<string>();
    for (let i = 0; i < MAX_PAGAMENTOS_COMBINADOS_SHOPEE; i += 1) {
      idsDeOwnership.add(makePagamentoIdShopee(contaId, orderSn, sufixoPagamentoShopee(i)));
    }
    const nossos = armazenados.filter((d) => idsDeOwnership.has(d.id));

    if (mapeados.docs.length === 0 && nossos.length === 0) {
      return resultadoSemEscrita('ignorado-sem-pagamento', {
        congelado,
        pedidoJaExistia: true,
        somaPagante: sumPagamentosPagos(armazenados.map((d) => linhaDeSoma(d.raw))),
        divergenciaDeSoma: null,
      });
    }

    /* -------------------------- the degraded delivery ----------------------- */
    // ⚠️ A later delivery carrying FEWER legs never deletes, never neutralises and
    // never re-takes the primary's `valor`: "one leg now" is a payload that lost
    // detail, not a payment that changed — whether `payment_info` survives past
    // READY_TO_SHIP is settle-live register item 22 and is NOT yet known, so the
    // shrink has to be read as detail loss either way. Re-taking would
    // double-count against the siblings.
    //
    // ⚠️ RELATIVE to what we OWN, never to the number two. A shrink from N legs
    // to any count in `[2, N)` is the same defect by a different route: the
    // mapped legs re-take their own `payment_amount` (which sums to
    // `valorCobrado` by the combined gate) while the leg that was NOT mapped
    // keeps the `valor` a richer delivery gave it, and Σ pagante exceeds the
    // nota by exactly that orphan — which stays pagante, so the NF-e sums it.
    // A delivery that maps NOTHING (the creation gate, an unusable `pay_time`)
    // is not degraded: there is no DATA group to run and nothing to freeze.
    const degradado = mapeados.docs.length > 0 && mapeados.docs.length < nossos.length;
    if (degradado) {
      // eslint-disable-next-line no-console -- counts only; the fact that a delivery lost detail is the finding
      console.info('[shopee/pagamentos] entrega degradada — grupo `dados` congelado', {
        orderSn,
        pedidoId,
        armazenados: nossos.length,
        recebidos: mapeados.docs.length,
      });
    }

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
    const conjuntoCongelado = (congelado || degradado) && nossos.length > 0;
    let naoCriados = 0;

    const ctx: ContextoPatch = { watermarkUs, congelado, degradado };
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
    let vereditoDoPrimario: VereditoStatusPagamentoShopee | null = null;

    const avaliar = (raw: Record<string, unknown> | null): VereditoStatusPagamentoShopee => {
      const veredito = statusPagamentoAplicavel(
        raw === null ? null : statusArmazenado(raw),
        alvoStatus,
      );
      if (veredito.escrever && veredito.ressuscitado) {
        statusRessuscitado = true;
        console.warn(
          '[shopee/pagamentos] status ressuscitado — um pagamento estornado voltou a valer',
          { orderSn, pedidoId, para: veredito.status },
        );
      }
      return veredito;
    };

    /* ------------------------- the mapped documents ------------------------- */
    for (const mapeado of mapeados.docs) {
      const ref = pagamentoCollection.docRef(db, { pedidoId }, mapeado.docId);
      const raw = porId.get(mapeado.docId);

      // ⚠️ Skipped BEFORE `avaliar`: a document this delivery does not create has
      // no status written and must not report one (nor raise a `ressuscitado`
      // warn about a document that does not exist).
      if (raw === undefined && conjuntoCongelado) {
        naoCriados += 1;
        continue;
      }

      const veredito = avaliar(raw ?? null);
      if (mapeado.indice === 0) vereditoDoPrimario = veredito;

      if (raw === undefined) {
        const corpo = corpoDeCriacao(mapeado, ctx, veredito);
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

      const patch = construirPatch(raw, mapeado, ctx, veredito);
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

    /* ---- documents of ours this delivery did NOT map (degraded / gated) ---- */
    const mapeadosPorId = new Set(mapeados.docs.map((m) => m.docId));
    for (const { id, raw } of nossos) {
      if (mapeadosPorId.has(id)) continue;
      const veredito = avaliar(raw);
      if (vereditoDoPrimario === null && id === makePagamentoIdShopee(contaId, orderSn)) {
        vereditoDoPrimario = veredito;
      }
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

    if (vereditoDoPrimario !== null) {
      statusEscrito = vereditoDoPrimario.escrever ? vereditoDoPrimario.status : null;
      motivoStatus = vereditoDoPrimario.escrever ? null : vereditoDoPrimario.motivo;
    }

    const somaPagante = sumPagamentosPagos([...projecao.values()]);
    const divergenciaDeSoma =
      valorCobradoPedido == null ? null : roundReais(somaPagante - valorCobradoPedido);

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
