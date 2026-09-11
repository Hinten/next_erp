/**
 * The WEEKLY SETTLEMENT write (#1514, step 6, plan §3.0-S S8) — one
 * `pedidos/{pedidoId}/pagamentos/{pagamentoId}` document, stamped with what
 * Shopee actually released.
 *
 * ## Why a settlement exists at all
 *
 * Shopee pushes nothing when money is released, and `escrow_amount` is
 * documented to MOVE until the order completes — so the figures the order-import
 * task wrote are a snapshot of an escrow that was still moving. The ONE surface
 * that exposes `escrow_release_time` is `get_escrow_list`, so a schedule pages
 * it per conta (`liquidacaoSweep.ts`) and this module writes the answer.
 *
 * ## Class B, and the two named guards (root rule 7)
 *
 * The escrow BODY (`get_escrow_detail`) and the `get_escrow_list` row are both
 * fetched OUTSIDE the callback and reach the write, so an OCC retry re-applies
 * them verbatim. Both decisions are therefore re-derived from the callback's own
 * `tx.get`:
 *
 *  1. **The release-time watermark, tier 2, in MICROseconds — and the unit IS
 *     the guard.** `escrow_list.escrow_release_time` is SECONDS and is converted
 *     ONCE, by {@link microsDeSegundosShopee}. ⚠️ Never by `coerceToMicros`,
 *     which classifies by MAGNITUDE, reads `1.65e9` as MILLIseconds and answers
 *     1970 — a settlement whose stored stamp says "older" for ever. Strictly
 *     NEWER stored ⇒ `ignorado-obsoleto`; EQUAL falls through to (2) (that is
 *     what makes the sweep's one-day window overlap idempotent), and a `null` on
 *     either side falls through too, because an absent release time is not
 *     evidence of order.
 *  2. **Field-by-field content equality** over the sweep-owned money keys.
 *     Identical ⇒ `ignorado-sem-mudanca` with ZERO writes. That is not an
 *     optimisation: `onPagamentoChanged` ignores only `id` and
 *     `ultimaModificacao`, so ANY write at all would file a
 *     `historicoDeModificacoes` row per conta per week, for ever.
 *     ⚠️ `liquidacao.liquidadoEmUs` is deliberately EXCLUDED from that
 *     comparison — it is `nowUs`, and comparing it makes the no-change branch
 *     unreachable.
 *
 * ⚠️ There is NO generic deep-equal here. Every comparison is written out, for
 * the #1372 reason: a fold decides which edits count as "no change" and
 * therefore which ones are silently never written.
 *
 * ## Disjoint masks
 *
 * `tx.update` masks at a TOP-LEVEL key, which is the whole reason `liquidacao`
 * is a top-level field rather than a member of `marketplace`: this sweep owns
 * `liquidacao`, the order task never names it, and `marketplace` — which both
 * writers own — is REBUILT here from the tx-fresh `raw.marketplace` with the
 * fresher escrow diary spread over it, so nothing an import learned is dropped.
 *
 * The money itself comes from the SAME pure `tarifasDeShopee` /
 * `diarioMarketplaceDeEscrow` the import mapper uses — imported, never
 * re-derived and never re-clamped — so a sweep write and a task write racing the
 * same pagamento agree by construction instead of by a comparison.
 *
 * ## What it never touches
 *
 * `valor`, `forma_de_pagamento`, `status_pagamento`, `parcelas`, `aVista`,
 * `duplicata`, `juros`, `cartao`, `cheque`, `descricaoPagamento`, `id`,
 * `metodoPagamentoOuterRef`, `nFat`, `vencimento`, `dataAprovacao`,
 * `dataCancelamento`, `dataCadastro` — and no pedido, no `estado`, no stock. So
 * `Σ pagante valor == pedido.valorCobrado` (and therefore `Σ vPag == vNF`)
 * cannot move from here. The write is `tx.update`, **never `tx.set`**: a set
 * would wipe every field in that list.
 *
 * ## Only an EXISTING pagamento
 *
 * An absent document answers `ignorado-sem-pagamento` and creates nothing. The
 * sweep parks that row in its cursor doc's `pendentes` and synthesizes a code 3,
 * so the pedido and its pagamento arrive by the normal import path — which is
 * the only path that knows the buyer-facing `valor` a nota has to sum.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { coerceToMicros, millisToMicros } from '@delfrance/core/datetime';
import { pagamentoCollection } from '@delfrance/data/admin/collections';
import {
  LIQUIDACAO_FONTE,
  MARKETPLACE_PEDIDO_TIPO,
  type MarketplacePagamentoTaxas,
} from '@delfrance/schemas';
import type { ShopeeEscrowDetail } from '@delfrance/integrations-shopee';

import { makePagamentoIdShopee } from './orderIds';
import { maiorUs, microsDeSegundosShopee } from './orderMapping';
import { diarioMarketplaceDeEscrow, tarifasDeShopee } from './pagamentoMapping';

/** What one settlement attempt did. */
export type AcaoLiquidacaoShopee =
  | 'liquidado'
  | 'ignorado-sem-pagamento'
  | 'ignorado-obsoleto'
  | 'ignorado-sem-mudanca';

export interface LiquidarPagamentoShopeeArgs {
  readonly pedidoId: string;
  readonly contaId: string;
  readonly orderSn: string;
  /** The FRESH `get_escrow_detail` body this tick read. */
  readonly escrow: ShopeeEscrowDetail;
  /** `get_escrow_list.escrow_release_time` — wire **SECONDS**, or `null`. */
  readonly escrowReleaseTimeS: number | null;
  /** `get_escrow_list.payout_amount` RAW — the unit is unresolved, so nothing converts it. */
  readonly payoutAmount: number | null;
  /**
   * ONE clock read for the tick, in MILLISECONDS.
   *
   * ⚠️ ms, not µs, and the boundary is the point: `liquidacaoSweep.ts` is pure
   * epoch milliseconds end to end and holds no microsecond anywhere, so the
   * ms → µs conversion happens HERE — in the one module of this pair that
   * already speaks µs (it also converts the incoming `escrow_release_time` from
   * SECONDS). A `* 1000` in the runner would be a fifth, undeclared converter in
   * a channel whose `CLAUDE.md` keeps that list countable on purpose.
   */
  readonly nowMs: number;
}

export interface ResultadoLiquidacaoShopee {
  readonly pagamentoId: string;
  readonly acao: AcaoLiquidacaoShopee;
  /** The INCOMING release time in µs (`null` when the row carried none). */
  readonly escrowReleaseTimeUs: number | null;
  /** Dotted names of the sweep-owned fields that differed — `[]` on every ignored outcome. */
  readonly campos: readonly string[];
}

/**
 * What {@link preverLiquidacaoShopee} decided about ONE stored document.
 *
 * ⚠️ It carries the PATCH rather than describing it, so the transaction has
 * nothing left to build: the decision and the bytes are one function, and the
 * rehearsal CLI's dry run therefore prints exactly what a live run would write
 * instead of a second implementation's opinion of it.
 */
export interface PrevisaoLiquidacaoShopee {
  readonly acao: AcaoLiquidacaoShopee;
  readonly escrowReleaseTimeUs: number | null;
  readonly campos: readonly string[];
  /** `null` on every outcome that writes nothing. */
  readonly patch: Record<string, unknown> | null;
}

export interface PreverLiquidacaoShopeeArgs {
  readonly orderSn: string;
  readonly escrow: ShopeeEscrowDetail;
  readonly escrowReleaseTimeS: number | null;
  readonly payoutAmount: number | null;
  /** MILLISECONDS — see {@link LiquidarPagamentoShopeeArgs.nowMs}. */
  readonly nowMs: number;
}

/* ------------------------------- raw readers ------------------------------ */

function numeroFinito(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function objetoDe(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function textoDe(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * The eight named fee columns, in ONE list so the comparison and the patch can
 * never disagree about which of them the sweep owns.
 *
 * ⚠️ Adding a column to `marketplacePagamentoTaxasSchema` without adding it here
 * makes that column invisible to the no-change check: it would be written on the
 * first tick that saw it and then never compared again.
 */
const CAMPOS_TAXAS = [
  'comissao',
  'servico',
  'transacaoVendedor',
  'campanha',
  'protecaoFrete',
  'processamento',
  'ajustes',
  'devolucoes',
] as const satisfies readonly (keyof MarketplacePagamentoTaxas)[];

/**
 * The whole settlement DECISION, as a pure function of the stored document.
 *
 * ⚠️ It exists so there is exactly ONE of it. The transaction below runs it on
 * its own `tx.get` snapshot; `liquidar:pagamentos --dry-run` runs it on a plain
 * read and prints the result. Any other arrangement would put a second copy of
 * the comparison in the rehearsal tool — and a rehearsal that disagrees with
 * production is worse than no rehearsal, which is exactly the defect shape the
 * root `CLAUDE.md` names.
 *
 * `raw` is `null` when the pagamento does not exist. Nothing here writes, reads
 * a clock or touches the network.
 */
export function preverLiquidacaoShopee(
  raw: Record<string, unknown> | null,
  args: PreverLiquidacaoShopeeArgs,
): PrevisaoLiquidacaoShopee {
  const { orderSn, escrow, escrowReleaseTimeS, payoutAmount, nowMs } = args;
  // The ONE ms → µs conversion of this pair, through the shared helper and never
  // an inline `* 1000`.
  const nowUs = millisToMicros(nowMs);

  // ⚠️ SECONDS → µs, exactly once, and never through `coerceToMicros`. See the
  // module header's guard (1).
  const incomingUs = escrowReleaseTimeS == null ? null : microsDeSegundosShopee(escrowReleaseTimeS);

  if (raw === null) {
    return {
      acao: 'ignorado-sem-pagamento',
      escrowReleaseTimeUs: incomingUs,
      campos: [],
      patch: null,
    };
  }

  /* -------------------------- guard (1): the watermark ---------------------- */

  const liquidacaoArmazenada = objetoDe(raw.liquidacao);
  const armazenadoUs = numeroFinito(liquidacaoArmazenada?.escrowReleaseTimeUs);
  if (armazenadoUs != null && incomingUs != null && armazenadoUs > incomingUs) {
    return {
      acao: 'ignorado-obsoleto',
      escrowReleaseTimeUs: incomingUs,
      campos: [],
      patch: null,
    };
  }

  /* ---------------------- the money, from the SHARED folds ------------------ */

  const { tarifas } = tarifasDeShopee(escrow);
  const diario = diarioMarketplaceDeEscrow(escrow);

  /* ------------------------- guard (2): content equality -------------------- */

  const campos: string[] = [];

  if (numeroFinito(liquidacaoArmazenada?.payoutAmount) !== payoutAmount) {
    campos.push('liquidacao.payoutAmount');
  }
  if (armazenadoUs !== incomingUs) campos.push('liquidacao.escrowReleaseTimeUs');
  if (textoDe(liquidacaoArmazenada?.fonte) !== LIQUIDACAO_FONTE.escrowList) {
    campos.push('liquidacao.fonte');
  }
  // ⚠️ `liquidacao.liquidadoEmUs` is NOT compared: it is `nowUs`, and a tick is
  // never the previous tick, so comparing it would make this whole branch
  // unreachable and file a history row every week.

  const marketplaceArmazenado = objetoDe(raw.marketplace);
  const taxasArmazenadas = objetoDe(marketplaceArmazenado?.taxas);
  if (diario !== undefined) {
    if (numeroFinito(marketplaceArmazenado?.buyerTotalAmount) !== diario.buyerTotalAmount) {
      campos.push('marketplace.buyerTotalAmount');
    }
    if (numeroFinito(marketplaceArmazenado?.escrowAmount) !== diario.escrowAmount) {
      campos.push('marketplace.escrowAmount');
    }
    if (
      numeroFinito(marketplaceArmazenado?.escrowAmountAfterAdjustment) !==
      diario.escrowAmountAfterAdjustment
    ) {
      campos.push('marketplace.escrowAmountAfterAdjustment');
    }
    if (numeroFinito(marketplaceArmazenado?.tarifasBrutas) !== diario.tarifasBrutas) {
      campos.push('marketplace.tarifasBrutas');
    }
    for (const campo of CAMPOS_TAXAS) {
      if (numeroFinito(taxasArmazenadas?.[campo]) !== (diario.taxas?.[campo] ?? null)) {
        campos.push(`marketplace.taxas.${campo}`);
      }
    }
  }

  // `undefined` ⇒ the escrow carried no `order_income`, so the key is OMITTED
  // rather than written as `null`: an unreadable escrow must never erase a fee
  // an earlier, richer delivery already learned (`tx.update` masks at the key).
  if (tarifas !== undefined && numeroFinito(raw.tarifas) !== tarifas) campos.push('tarifas');

  if (campos.length === 0) {
    return {
      acao: 'ignorado-sem-mudanca',
      escrowReleaseTimeUs: incomingUs,
      campos: [],
      patch: null,
    };
  }

  /* --------------------------------- the patch ------------------------------ */

  const patch: Record<string, unknown> = {
    liquidacao: {
      payoutAmount,
      escrowReleaseTimeUs: incomingUs,
      liquidadoEmUs: nowUs,
      fonte: LIQUIDACAO_FONTE.escrowList,
    },
    // Monotone and never null: the stored stamp goes through `coerceToMicros`
    // because the legacy corpus holds ms ints and ISO strings THERE — the
    // incoming side above is already µs and must never meet that helper.
    ultimaModificacao: maiorUs(coerceToMicros(raw.ultimaModificacao), nowUs),
  };

  if (diario !== undefined) {
    // REBUILT, not patched: `update` replaces the whole map at a top-level key,
    // so the stored half (`tipo`, `orderSn`, `atualizadoEm`, and anything a
    // later step adds behind `.passthrough()`) has to be carried over
    // explicitly. `atualizadoEm` is the ORDER clock and this sweep has none — it
    // keeps whatever the last delivery stamped.
    const base = marketplaceArmazenado ?? {};
    const marketplace: Record<string, unknown> = { ...base, ...diario };
    // ⚠️ `tipo` is the one REQUIRED field of `marketplacePagamentoSchema`, and a
    // pagamento whose import could not read an escrow has `marketplace: null` —
    // so the sweep may genuinely be the first writer of this map. Both fallbacks
    // are facts the sweep knows for certain (it is settling THIS Shopee order);
    // a stored value always wins.
    if (textoDe(marketplace.tipo) === null) marketplace.tipo = MARKETPLACE_PEDIDO_TIPO.shopee;
    if (textoDe(marketplace.orderSn) === null) marketplace.orderSn = orderSn;
    patch.marketplace = marketplace;
  }
  if (tarifas !== undefined) patch.tarifas = tarifas;

  return { acao: 'liquidado', escrowReleaseTimeUs: incomingUs, campos, patch };
}

/**
 * Settle ONE pagamento against a fresher escrow. Class **B** — see the module
 * header and the entry in
 * `packages/config-eslint/rules/firestore-transaction-inventory.test.js`.
 */
export async function liquidarPagamentoShopee(
  db: Firestore,
  args: LiquidarPagamentoShopeeArgs,
): Promise<ResultadoLiquidacaoShopee> {
  const { pedidoId, contaId, orderSn, escrow, escrowReleaseTimeS, payoutAmount, nowMs } = args;

  // The PRIMARY pagamento — index 0, no suffix. A combined payment's secondary
  // legs carry no marketplace money of their own (the fee rides the primary and
  // the siblings hold a real `0`), so there is exactly one document to settle.
  const pagamentoId = makePagamentoIdShopee(contaId, orderSn);

  return db.runTransaction(async (tx: Transaction) => {
    const ref = pagamentoCollection.docRef(db, { pedidoId }, pagamentoId);
    const snap = await tx.get(ref);
    // RAW, deliberately not `parseRead`: its soft parse RETURNS the raw object on
    // a failed parse, so reading through it would buy nothing and would warn on
    // every legacy pagamento this sweep walks past.
    const raw = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;

    // ⚠️ Every decision is re-derived from THIS transaction's own read — the
    // function is pure and the snapshot is the only input that can have moved.
    const previsao = preverLiquidacaoShopee(raw, {
      orderSn,
      escrow,
      escrowReleaseTimeS,
      payoutAmount,
      nowMs,
    });

    if (previsao.patch !== null) {
      // ⚠️ `tx.update`, NEVER `tx.set` — a set would wipe `valor`,
      // `forma_de_pagamento`, `cartao` and every other field the order task owns.
      tx.update(ref, pagamentoCollection.parseMerge(previsao.patch));
    }

    return {
      pagamentoId,
      acao: previsao.acao,
      escrowReleaseTimeUs: previsao.escrowReleaseTimeUs,
      campos: previsao.campos,
    } satisfies ResultadoLiquidacaoShopee;
  });
}
