import {
  aggregateTotals,
  buildImpostoXml,
  buildPagXml,
  buildTotalXml,
  buildTranspXml,
  datePartsInOffset,
  offsetForUF,
  sanitizeNFeText,
  type GeneratorInput,
  type GeneratorItem,
  type Payment,
} from '@delfrance/integrations-nfe';
import { microsToMillis } from '@delfrance/core/datetime';
import { roundReais } from '@delfrance/core/money';
import {
  MODALIDADE_FRETE,
  IND_INTERMED_OPERACAO,
  FORMA_PAGAMENTO,
  type Filial,
  type FreteDoPedido,
  type Integracao,
  type Operacao,
  type Pagamento,
} from '@delfrance/schemas';

import type { NFeRuntime } from '../runtime';
import { NFeOrchestratorError } from './errors';
import type { FiscalItem, PedidoBundle } from './bundle';

/**
 * Project the validated fiscal items + filial + cliente + operação +
 * counters into the typed `GeneratorInput`.
 *
 * **Fiscal-code resolution (CFOP / NCM / unidade / CEST).** Per the
 * Flutter resolver chain: the **item's** stamped imposto wins; when
 * a field is missing on the item we fall back to the operação's
 * matching field. Only when BOTH are missing do we throw. This
 * matches marketplace reality — many orders carry an operação-default
 * CFOP/NCM and only stamp item-level overrides for the products that
 * need them.
 */
export function buildGeneratorInput(
  bundle: PedidoBundle,
  items: ReadonlyArray<FiscalItem>,
  numeracao: number,
  serie: number,
  ambiente: NFeRuntime['ambiente'],
  tpEmis: GeneratorInput['tpEmis'] = 1,
  cNF?: string,
  contingencia?: { readonly dhCont: Date | null; readonly xJust: string | null } | null,
  emitRtc?: boolean,
): GeneratorInput {
  const isInterstate = bundle.enderecoDest.estado !== bundle.filial.sede.estado;
  const genItems = buildGenItems(items, bundle, isInterstate, emitRtc === true);

  // Compute frete value upfront so it can ride into both the totals
  // aggregator (NF-e level) and onto a det's prod.vFrete (item level)
  // when the issuer contracts the carrier (modalidade='0').
  const freteEmitente =
    bundle.frete?.modalidade === MODALIDADE_FRETE.cif && (bundle.frete.valorCobrado ?? 0) > 0;
  const vFrete = freteEmitente ? (bundle.frete!.valorCobrado as number) : 0;
  if (vFrete > 0 && genItems.length > 0) {
    // Mirror of Flutter `pedido_nfe_base.dart:932`: stamp the full frete
    // value onto the first <det>'s <prod>. Phase D could split this
    // proportionally across items; Flutter doesn't. The target must be the
    // first COMPOSING item — a det-level vFrete on an indTot='0' item would
    // fall out of the indTot-conditioned ICMSTot.vFrete Σ-rule (#398).
    const at = genItems.findIndex((g) => g.indTot !== '0');
    if (at === -1) {
      // Every item is fora do total: no composing det can carry the frete, so
      // ICMSTot.vFrete could never equal the indTot-gated Σ det vFrete and
      // SEFAZ would reject. Fail loudly instead of stamping an excluded det.
      throw new NFeOrchestratorError(
        `pedido '${bundle.pedidoId}': frete por conta do emitente (R$ ${vFrete.toFixed(2)}) ` +
          `mas nenhum item compõe o total da NF-e (indTot='0' em todos) — ` +
          `não há det para receber o vFrete`,
      );
    }
    const target = genItems[at]!;
    genItems[at] = { ...target, vFrete };
  }

  // Total discount = Σ per-item <vDesc> (unit discount + apportioned
  // descontoTotal), computed once in buildGenItems and carried on each genItem.
  // Only COMPOSING items count — an indTot='0' item keeps its det-level vDesc
  // but its value never entered ICMSTot.vProd, so subtracting its discount
  // from the totals would understate vNF (#398).
  const vDesc = roundReais(
    genItems.reduce((sum, gi) => sum + (gi.indTot !== '0' ? (gi.vDesc ?? 0) : 0), 0),
  );
  const totals = aggregateTotals(
    // `vProd` = GROSS (rolls into ICMSTot.vProd = Σ wire <vProd>); `vBaseTributavel`
    // = net-of-unit-discount base for the RTC total (matches the per-item base
    // buildGenItems passes to buildImpostoXml). vNF subtracts `vDesc` below.
    // `indTot` mirrors the det projection (same `indTotFor`) so the wire flag
    // and the ICMSTot gating can never diverge.
    items.map((it) => ({
      item: { vProd: it.vProdBruto, vBaseTributavel: it.vProd, indTot: indTotFor(it) },
      imposto: it.imposto,
    })),
    { vFrete, vDesc },
    { emitRtc: emitRtc === true },
  );
  const payments = buildPaymentsFromPagamentos(bundle.pagamentos, {
    vNF: totals.vNF,
    frete: bundle.frete,
  });

  // Σ vPag ↔ vNF pre-send guard (NT 2025.001 YA03-10/-20 → rejections 865/866).
  // A mismatch (duplicated/partial/over-recorded pagamentos) would only surface
  // as a SEFAZ rejection after numeração was allocated — fail loudly here
  // instead, naming the values so the operator fixes the pagamentos. Skipped
  // when every entry is tPag='90' (sem pagamento — the empty-list default and
  // explicit no-payment records legitimately carry vPag=0 ≠ vNF).
  const allSemPagamento = payments.every((pay) => pay.tPag === '90');
  if (!allSemPagamento) {
    const somaVPag = roundReais(payments.reduce((sum, pay) => sum + pay.vPag, 0));
    if (somaVPag !== totals.vNF) {
      throw new NFeOrchestratorError(
        `pedido '${bundle.pedidoId}': payments total (R$ ${somaVPag.toFixed(2)}) differs ` +
          `from the NF-e total (R$ ${totals.vNF.toFixed(2)}) — SEFAZ would reject with cStat ` +
          `${somaVPag < totals.vNF ? '865' : '866'}. Fix the pedido's pagamentos before emitting.`,
      );
    }
  }

  // Referenced NF-es (devolução/complementar) → ide.NFref[].refNFe. The pedido
  // stores chaves in `chNFeReferenciadas` (44-digit validated on the FiscalTab);
  // buildIde re-validates each and throws on a malformed one.
  const rawRefs = (bundle.pedido as { chNFeReferenciadas?: unknown }).chNFeReferenciadas;
  const chNFeReferenciadas = Array.isArray(rawRefs)
    ? rawRefs.filter((c): c is string => typeof c === 'string' && c.length > 0)
    : [];

  const transpOpts = buildTranspFromFrete(bundle.frete);
  const cobr = buildCobrFromPagamentos(bundle.pagamentos, {
    vNF: totals.vNF,
    frete: bundle.frete,
    // dVenc is a calendar date — read it in the issuer's legal time (#395).
    utcOffsetMinutes: offsetForUF(bundle.filial.sede.estado),
  });
  const infAdic = buildInfAdic(bundle.pedido, bundle.operacao);
  const exporta = buildExporta(bundle.operacao, bundle.filial);
  const infIntermed = buildInfIntermed(bundle.integracao, bundle.operacao);

  return {
    ambiente,
    numeracao,
    serie,
    tpEmis,
    dhEmi: new Date(),
    filial: bundle.filial,
    operacao: bundle.operacao,
    cliente: bundle.cliente,
    enderecoDest: bundle.enderecoDest,
    itens: genItems,
    totalXml: buildTotalXml(totals),
    transpXml: buildTranspXml(transpOpts),
    pagXml: buildPagXml(payments),
    ...(cobr ? { cobr } : {}),
    ...(infAdic ? { infAdic } : {}),
    ...(exporta ? { exporta } : {}),
    ...(infIntermed ? { infIntermed } : {}),
    ...(cNF ? { cNF } : {}),
    ...(chNFeReferenciadas.length > 0 ? { chNFeReferenciadas } : {}),
    // B28/B29 — the generator's validateInput enforces presence (tpEmis≠1)
    // and absence (tpEmis=1); here we only thread the values through.
    ...(contingencia?.dhCont ? { dhCont: contingencia.dhCont } : {}),
    ...(contingencia?.xJust ? { xJust: contingencia.xJust } : {}),
  };
}

/**
 * Project validated `FiscalItem`s into the typed `GeneratorItem[]` the
 * NF-e generator consumes. Resolves CFOP / NCM / unidade / CEST with the
 * item-imposto winning over the operação fallback; throws when both are
 * missing.
 *
 * Stops short of the Flutter resolver chain
 * (item → product → categoria → operação) at
 * `.old/packages/pedido_nfe/lib/src/pedido_nfe_base.dart:746` — that's a
 * Phase D port. Today every pedido item must arrive with `imposto`
 * already stamped (see `flattenAndValidate`).
 */
export function buildGenItems(
  items: ReadonlyArray<FiscalItem>,
  bundle: PedidoBundle,
  isInterstate: boolean,
  emitRtc = false,
): GeneratorItem[] {
  const cfopField = isInterstate ? 'cfopInterestadual' : 'cfop';
  const vDescByIndex = apportionDescontos(items, bundle);
  return items.map((it, i) => {
    const where = `pedido '${bundle.pedidoId}' item ${it.itemIndex} (produto '${it.produtoUid}')`;
    const cfop = it.imposto[cfopField] ?? bundle.operacao[cfopField];
    if (!cfop) {
      throw new NFeOrchestratorError(
        `${where}: no ${cfopField} — neither imposto.${cfopField} nor operacao.${cfopField} is set`,
      );
    }
    const NCM = it.imposto.NCM ?? bundle.operacao.NCM;
    if (!NCM) {
      throw new NFeOrchestratorError(
        `${where}: no NCM — neither imposto.NCM nor operacao.NCM is set`,
      );
    }
    const unidade = it.imposto.unidade ?? bundle.operacao.unidade;
    if (!unidade) {
      throw new NFeOrchestratorError(
        `${where}: no unidade — neither imposto.unidade nor operacao.unidade is set`,
      );
    }
    // CEST is optional — required only when the product is in the CEST
    // list. Item wins, operação as fallback, omit when neither set.
    const CEST = it.imposto.CEST ?? bundle.operacao.CEST;

    const cProd = it.sku ?? it.gtin!; // guarded in flattenAndValidate
    const cEAN = it.gtin && /^\d{8,14}$/.test(it.gtin) ? it.gtin : 'SEM GTIN';
    const vDesc = vDescByIndex[i]!;
    if (vDesc > it.vProdBruto) {
      throw new NFeOrchestratorError(
        `${where}: desconto (R$ ${vDesc.toFixed(2)}) exceeds the gross item value ` +
          `(R$ ${it.vProdBruto.toFixed(2)}) — check descontoUnitario/descontoTotal`,
      );
    }
    return {
      nItem: i + 1,
      cProd,
      cEAN,
      xProd: it.nomeDeVenda!, // guarded in flattenAndValidate
      NCM,
      ...(CEST ? { CEST } : {}),
      CFOP: cfop,
      uCom: unidade,
      qCom: it.quantidade,
      vUnCom: it.precoDeVenda,
      // `<prod><vProd>` is GROSS (qCom × vUnCom) so SEFAZ rule 629 holds; the
      // discount rides in `<vDesc>` and `vNF = Σ(vProd − vDesc)`.
      vProd: it.vProdBruto,
      ...(vDesc > 0 ? { vDesc } : {}),
      cEANTrib: cEAN,
      uTrib: unidade,
      qTrib: it.quantidade,
      vUnTrib: it.precoDeVenda,
      indTot: indTotFor(it),
      // Tribute base stays net-of-unit-discount (`it.vProd`, matches the legacy
      // Flutter `item.subtotal`), unaffected by the gross wire value above.
      impostoXml: buildImpostoXml(it.imposto, { vProd: it.vProd }, { emitRtc }),
    };
  });
}

/**
 * `det.prod.indTot` for a fiscal item — `'0'` only when the resolved imposto
 * explicitly opts the item out of the NF-e totals (`compoeValorTotalDaNFe ===
 * false`; absent/null = composes, the legacy Flutter default). Computed ONCE
 * and consumed by the det projection, the discount apportionment AND the
 * totals aggregation, so the wire flag and the ICMSTot gating can never
 * diverge (#398 — `compoeValorTotalDaNFe` used to never reach emission).
 */
export function indTotFor(it: FiscalItem): '0' | '1' {
  return it.imposto.compoeValorTotalDaNFe === false ? '0' : '1';
}

/**
 * Apportion the pedido-level `descontoTotal` across items, returning each item's
 * total `<vDesc>` (its unit discount `descontoUnitário × qtd` PLUS its share of
 * the order-level discount). The order discount is split proportional to each
 * item's net subtotal (`it.vProd`) so `Σ vDesc` exactly equals
 * `Σ(descUnit×qtd) + descontoTotal`.
 *
 * Items with `indTot='0'` (não compõem o total, #398) take NO share of the
 * order-level discount — their value never enters ICMSTot.vProd, so a share
 * allocated to them would silently vanish from the totals `vDesc`/`vNF`.
 * They keep their own unit discount on the det. The running-cumulative pin
 * lands on the last COMPOSING item for the same reason.
 *
 * Uses the **rounded-running-cumulative** method: each item's order share is
 * `round(cumulativeWeightThroughItem / vTotNet × descontoTotal) − alreadyAllocated`.
 * Because the rounded cumulative target is monotonic non-decreasing and capped at
 * `descontoTotal` on the last item, every share is `≥ 0` and the sum lands exactly
 * on `descontoTotal` — no over-allocation and no negative remainder.
 *
 * The naïve "round each share independently, last item takes the remainder"
 * approach (like the legacy Flutter generator, `.old/…/pedido_nfe_base.dart:907`)
 * overshoots when several proportional shares land on a half-cent: e.g. a R$0,50
 * discount over 20 equal items rounds each 0,025 share up to 0,03, summing to
 * R$0,57 > R$0,50 and forcing a negative last share. Flutter threw on that; we
 * avoid it entirely so no valid order fails to emit.
 */
export function apportionDescontos(
  items: ReadonlyArray<FiscalItem>,
  bundle: PedidoBundle,
): number[] {
  const rawTotal = Number((bundle.pedido as { descontoTotal?: unknown }).descontoTotal ?? 0);
  const descontoTotal = Number.isFinite(rawTotal) && rawTotal > 0 ? roundReais(rawTotal) : 0;
  const composes = items.map((it) => indTotFor(it) !== '0');
  const vTotNet = roundReais(items.reduce((sum, it, i) => sum + (composes[i] ? it.vProd : 0), 0));
  const apportion = descontoTotal > 0 && vTotNet > 0;
  const lastComposing = composes.lastIndexOf(true);
  let weightSoFar = 0;
  let allocated = 0;
  return items.map((it, i) => {
    const unitDesc = roundReais((it.descontoUnitario ?? 0) * it.quantidade);
    let orderShare = 0;
    if (apportion && composes[i]) {
      weightSoFar = roundReais(weightSoFar + it.vProd);
      // Cumulative discount that should be allocated through this item; the last
      // composing item is pinned to the full descontoTotal so rounding never
      // leaks a cent.
      const cumTarget =
        i === lastComposing ? descontoTotal : roundReais((weightSoFar / vTotNet) * descontoTotal);
      orderShare = roundReais(cumTarget - allocated);
      allocated = roundReais(allocated + orderShare); // == cumTarget
    }
    return roundReais(unitDesc + orderShare);
  });
}

/**
 * Project filtered Pagamentos into typed `Payment` entries — mirrors
 * Flutter's `pedido_nfe_base.dart:1766` (`get pag`) field-for-field:
 *
 *   - empty list → single `tPag='90'` (sem pagamento), `vPag=0` (Flutter's
 *     `1768–1776` default — SEFAZ-safe, no `<xPag>` needed).
 *   - per Pagamento: `tPag` = `forma_de_pagamento` padded to 2 digits;
 *     `vPag` = `valor` ONLY (or 0 when `forma=90`). **`juros` is deliberately
 *     excluded** (diverging from Flutter, which pre-dated NT 2025.001):
 *     interest is gateway/marketplace financing cost, not part of the
 *     operation value — it is absent from `vNF` and from the app's own
 *     paid-reconcile (`pageModel` compares `valor` vs `valorCobrado`), so
 *     including it makes Σ vPag > vNF with no `<vTroco>` → SEFAZ rejection
 *     866 (YA03-20). If the company ever charges its own financing, the
 *     correct path is folding it into `vNF` via `extras.vOutro` (+ det[0]
 *     stamping, mirroring `vFrete`) — NOT re-adding it here.
 *   - `indPag`: `'1'` (a prazo) whenever `duplicata === true` — a duplicata
 *     is by definition a prazo, and `aVista` defaults to true on the schema,
 *     so trusting it would emit `indPag='0'` alongside a `<cobr>` block →
 *     SEFAZ rejection 853 (Y09-40). Otherwise from `aVista` (0=à vista,
 *     1=a prazo).
 *   - `xPag` is stamped ONLY when `forma=99` (outros) — the absence of it
 *     on `tPag='99'` is exactly what triggers SEFAZ cStat=441. Falls back
 *     to `'Outro'` when `descricaoPagamento` is blank (Flutter line 1801).
 *   - `card` is stamped ONLY when `cartao != null` AND `forma != 99` —
 *     mirror of `pedido_nfe_base.dart:1812`. NB: SEFAZ NT 2022.001
 *     REQUIRES the `<card>` block on every card-like tPag (03 crédito,
 *     04 débito, **17 PIX**), so card-like Pagamentos must arrive with
 *     `cartao` already populated by the payment-gateway integration —
 *     otherwise SEFAZ rejects with cStat=391. We do not auto-stamp a
 *     placeholder here on purpose: silent defaults make fiscal bugs
 *     invisible.
 *   - **frete-emitente single-payment override**: when the issuer
 *     contracts the carrier (`frete.modalidade='0'`), frete has a
 *     non-zero `valorCobrado`, AND there's exactly one pagamento
 *     (whose forma isn't 90 — sem pagamento), Flutter overrides the
 *     payment's `vPag` to `vNF` so the wire reflects "the customer
 *     pays this amount, which includes the freight cost". Mirror of
 *     `pedido_nfe_base.dart:1790-1821`.
 */
export function buildPaymentsFromPagamentos(
  pagamentos: ReadonlyArray<Pagamento>,
  ctx: { vNF: number; frete: FreteDoPedido | null } = { vNF: 0, frete: null },
): Payment[] {
  if (pagamentos.length === 0) {
    return [{ tPag: '90', vPag: 0 }];
  }
  const freteEmitenteOverride =
    pagamentos.length === 1 &&
    ctx.frete?.modalidade === MODALIDADE_FRETE.cif &&
    (ctx.frete.valorCobrado ?? 0) > 0;

  return pagamentos.map((p): Payment => {
    const isOutros = p.forma_de_pagamento === FORMA_PAGAMENTO.outros;
    const isSemPag = p.forma_de_pagamento === FORMA_PAGAMENTO.sem_pagamento;
    const tPag = String(p.forma_de_pagamento).padStart(2, '0') as Payment['tPag'];
    let vPag: number;
    if (isSemPag) {
      vPag = 0;
    } else if (freteEmitenteOverride) {
      vPag = ctx.vNF;
    } else {
      // Round at the source so the wire (<vPag> via toFixed), the Σ vPag ↔ vNF
      // guard and SEFAZ's own YA03 summation all see the SAME 2-decimal value —
      // pagamentoSchema.valor has no decimal constraint, and a sub-cent valor
      // rounded differently in each place would let the guard pass a note the
      // wire mis-sums (or block one SEFAZ would accept).
      vPag = roundReais(p.valor);
    }
    // A duplicata is by definition a prazo — see the doc block above.
    const indPag: NonNullable<Payment['indPag']> = p.duplicata || !p.aVista ? '1' : '0';

    let xPag: string | undefined;
    if (isOutros) {
      const desc = (p.descricaoPagamento ?? '').trim();
      const cleaned = sanitizeNFeText(desc.length > 0 ? desc : 'Outro', 60);
      xPag = cleaned ?? 'Outro';
    }

    const card = p.cartao != null && !isOutros ? buildCardFromCartao(p.cartao) : undefined;

    return {
      tPag,
      vPag,
      indPag,
      ...(xPag ? { xPag } : {}),
      ...(card ? { card } : {}),
    };
  });
}

/**
 * Project the pass-through `Pagamento.cartao` blob into the typed
 * `Payment.card`. The schema declares `cartao` as `z.unknown()` (Flutter's
 * Cartao model is wider than SEFAZ needs), so we narrow defensively and
 * skip the whole block when `tpIntegra` is missing — emitting a `<card>`
 * without `tpIntegra` would be invalid against the XSD and trigger
 * cStat=391.
 *
 * Flutter source: `.old/packages/pedido/lib/src/models.dart` Cartao
 * (used at `pedido_nfe_base.dart:1812–1820`).
 */
export function buildCardFromCartao(cartao: unknown): NonNullable<Payment['card']> | undefined {
  if (cartao == null || typeof cartao !== 'object') return undefined;
  const c = cartao as Record<string, unknown>;
  const tpIntegraRaw = c.tpIntegra;
  const tpIntegraStr = typeof tpIntegraRaw === 'number' ? String(tpIntegraRaw) : tpIntegraRaw;
  if (tpIntegraStr !== '1' && tpIntegraStr !== '2') return undefined;
  const card: NonNullable<Payment['card']> = { tpIntegra: tpIntegraStr };
  if (typeof c.cnpj_instituicao === 'string') card.CNPJ = c.cnpj_instituicao;
  if (typeof c.bandeira === 'string') card.tBand = c.bandeira;
  else if (typeof c.bandeira === 'number') card.tBand = String(c.bandeira);
  if (typeof c.cAut === 'string') card.cAut = c.cAut;
  return card;
}

/**
 * Project `pedido.freteInicial` into the typed `<transp>` input.
 * Mirrors Flutter `pedido_nfe_base.dart:1504-1702`:
 *   - null frete OR modalidade='9' → just modFrete='9'.
 *   - Otherwise route on modalidade and forward transporta / veicTransp /
 *     reboque / vol / vagao / balsa as available.
 *
 * Free-text fields go through `sanitizeNFeText` (maxLen per XSD): xNome /
 * xEnder / xMun ≤60, vol[i].esp / marca / nVol ≤60, vol[i].lacres[j] ≤60.
 * We don't gate on a specific modalidade beyond '9' — every other code
 * carries the same optional sub-blocks at the XSD level; emit what we have.
 */
export function buildTranspFromFrete(frete: FreteDoPedido | null): {
  modFrete: '0' | '1' | '2' | '3' | '4' | '9';
  transporta?: NonNullable<Parameters<typeof buildTranspXml>[0]>['transporta'];
  veicTransp?: NonNullable<Parameters<typeof buildTranspXml>[0]>['veicTransp'];
  reboque?: NonNullable<Parameters<typeof buildTranspXml>[0]>['reboque'];
  vol?: NonNullable<Parameters<typeof buildTranspXml>[0]>['vol'];
  vagao?: string;
  balsa?: string;
} {
  if (frete == null || frete.modalidade === MODALIDADE_FRETE.semTransporte) {
    return { modFrete: '9' };
  }
  const out: ReturnType<typeof buildTranspFromFrete> = { modFrete: frete.modalidade };

  if (frete.transportadora) {
    // `freteInicial.transportadora` carries the Flutter wire names
    // (cnpj/ie/nome/endereco/municipio/uf — see `transportadoraSchema`);
    // the XSD names (CNPJ/IE/xNome/xEnder/xMun/UF) exist only from this
    // projection onward. Flutter parity: pedido_nfe_base.dart:1521-1527 —
    // the legacy wire has no CPF carrier, only a 14-digit `cnpj`, and the
    // IE is stripped to alphanumerics before emission.
    const t = frete.transportadora;
    const transporta: NonNullable<typeof out.transporta> = {};
    if (typeof t.cnpj === 'string' && t.cnpj) transporta.CNPJ = t.cnpj;
    const xNome = sanitizeNFeText(t.nome, 60);
    if (xNome) transporta.xNome = xNome;
    if (typeof t.ie === 'string') {
      const ie = t.ie.replace(/[^0-9A-Za-z]/g, '');
      if (ie) transporta.IE = ie;
    }
    const xEnder = sanitizeNFeText(t.endereco, 60);
    if (xEnder) transporta.xEnder = xEnder;
    const xMun = sanitizeNFeText(t.municipio, 60);
    if (xMun) transporta.xMun = xMun;
    if (typeof t.uf === 'string' && t.uf) {
      transporta.UF = t.uf as NonNullable<typeof transporta.UF>;
    }
    if (Object.keys(transporta).length > 0) out.transporta = transporta;
  }

  if (frete.veiculo?.placa) {
    // Flutter wire: placa/uf/rntc (veiculoSchema) → XSD placa/UF/RNTC.
    out.veicTransp = {
      placa: frete.veiculo.placa,
      ...(frete.veiculo.uf
        ? { UF: frete.veiculo.uf as NonNullable<typeof out.veicTransp>['UF'] }
        : {}),
      ...(frete.veiculo.rntc ? { RNTC: frete.veiculo.rntc } : {}),
    };
  }

  if (frete.reboques && frete.reboques.length > 0) {
    const reboques = frete.reboques
      .filter((r) => typeof r.placa === 'string' && r.placa)
      .map((r) => ({
        placa: r.placa as string,
        ...(r.uf ? { UF: r.uf as NonNullable<typeof out.veicTransp>['UF'] } : {}),
        ...(r.rntc ? { RNTC: r.rntc } : {}),
      }));
    if (reboques.length > 0) out.reboque = reboques;
  }

  if (frete.vagao) out.vagao = frete.vagao;
  if (frete.balsa) out.balsa = frete.balsa;

  if (frete.volumes && frete.volumes.length > 0) {
    // `pedido.freteInicial.volumes` carries the Flutter wire names
    // (quantidade/especie/numero/pesoBruto/pesoLiquido — see `volumeSchema`
    // in @delfrance/schemas); the NFe XSD names (qVol/esp/nVol/pesoB/pesoL)
    // exist only from this projection onward.
    const vols = frete.volumes.map((v) => {
      const vol: NonNullable<typeof out.vol>[number] = {};
      if (typeof v.quantidade === 'number' && Number.isInteger(v.quantidade) && v.quantidade >= 0) {
        vol.qVol = v.quantidade;
      }
      const esp = sanitizeNFeText(v.especie, 60);
      if (esp) vol.esp = esp;
      const marca = sanitizeNFeText(v.marca, 60);
      if (marca) vol.marca = marca;
      const nVol = sanitizeNFeText(v.numero, 60);
      if (nVol) vol.nVol = nVol;
      if (typeof v.pesoLiquido === 'number' && v.pesoLiquido >= 0) vol.pesoL = v.pesoLiquido;
      if (typeof v.pesoBruto === 'number' && v.pesoBruto >= 0) vol.pesoB = v.pesoBruto;
      if (Array.isArray(v.lacres) && v.lacres.length > 0) {
        // Seal numbers → <lacres><nLacre> (Flutter parity:
        // pedido_nfe_base.dart:1548). toVol wraps each string.
        const lacres = v.lacres
          .map((l) => sanitizeNFeText(typeof l === 'string' ? l : null, 60))
          .filter((l): l is string => l !== null);
        if (lacres.length > 0) vol.lacres = lacres;
      }
      return vol;
    });
    out.vol = vols;
  }

  return out;
}

/**
 * Project the duplicata-style pagamentos into a `<cobr>` block.
 * Mirror of Flutter `pedido_nfe_base.dart:487-521`:
 *   - Filter pagamentos where `duplicata === true`.
 *   - Empty → return undefined (orchestrator omits `<cobr>`).
 *   - Otherwise: fat = { vOrig, vLiq } summing all duplicata vPag;
 *     dup[] one per duplicata with vDup + optional nDup + dVenc.
 *
 * `vDup`/`vOrig` use `valor` ONLY — `juros` is excluded for the same reason
 * as `vPag` (see `buildPaymentsFromPagamentos`): the duplicatas must stay
 * consistent with `<pag>` and `vNF`, or the NT 2025.001 payment-total rules
 * reject the note. Phase A doesn't apply `vDesc` at the fatura level.
 *
 * `ctx` mirrors `buildPaymentsFromPagamentos`: when the frete-emitente
 * single-payment override rewrites that payment's `vPag` to `vNF`, the same
 * value must flow into its `vDup`/`vOrig` — otherwise `<pag>` and `<cobr>`
 * disagree by the freight amount on the wire. `utcOffsetMinutes` is the
 * issuer's legal-time offset (`offsetForUF(filial.sede.estado)`) — `dVenc`
 * is a calendar DATE and must be read in the issuer's offset, not UTC
 * (#395: an evening-BRT vencimento instant is the NEXT day in UTC).
 */
export function buildCobrFromPagamentos(
  pagamentos: ReadonlyArray<Pagamento>,
  ctx: { vNF: number; frete: FreteDoPedido | null; utcOffsetMinutes?: number } = {
    vNF: 0,
    frete: null,
  },
):
  | {
      fat?: { nFat?: string; vOrig?: string; vDesc?: string; vLiq?: string };
      dup?: ReadonlyArray<{ nDup?: string; dVenc?: string; vDup: string }>;
    }
  | undefined {
  // A forma=90 (sem pagamento) entry emits vPag=0 and represents no cobrança —
  // a stray duplicata flag on it must not produce a <cobr> block that the
  // <pag> totals contradict.
  const dups = pagamentos.filter(
    (p) => p.duplicata === true && p.forma_de_pagamento !== FORMA_PAGAMENTO.sem_pagamento,
  );
  if (dups.length === 0) return undefined;

  const freteEmitenteOverride =
    pagamentos.length === 1 &&
    ctx.frete?.modalidade === MODALIDADE_FRETE.cif &&
    (ctx.frete.valorCobrado ?? 0) > 0;

  // Issuer-offset calendar date (default: Brasília, for direct/test callers).
  const utcOffset = ctx.utcOffsetMinutes ?? -180;
  const dateInIssuerOffset = (instant: Date): string => {
    const { year, month, day } = datePartsInOffset(instant, utcOffset);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };

  // SEFAZ rejects dVenc more than 10 years out (rejection 797, Y09-50,
  // NT 2025.001). Compare DATES (the wire carries YYYY-MM-DD) on the same
  // issuer-offset basis — an end-of-day vencimento exactly on the +10y date
  // must not false-throw.
  const nowParts = datePartsInOffset(new Date(), utcOffset);
  const dVencLimit = `${nowParts.year + 10}-${String(nowParts.month).padStart(2, '0')}-${String(
    nowParts.day,
  ).padStart(2, '0')}`;

  const dup = dups.map((p, i) => {
    // Same rounding + override rules as the payment's vPag (see above).
    const valor = freteEmitenteOverride ? ctx.vNF : roundReais(p.valor);
    const out: { nDup?: string; dVenc?: string; vDup: string } = {
      vDup: valor.toFixed(2),
    };
    out.nDup = String(i + 1).padStart(3, '0');
    if (p.vencimento != null) {
      // pagamento.vencimento is `microsSinceEpoch()` (µs since epoch); nullish
      // check, not truthy — 0 (Unix epoch) is a valid timestamp.
      const parsed = new Date(microsToMillis(p.vencimento));
      if (!Number.isNaN(parsed.getTime())) {
        const dVenc = dateInIssuerOffset(parsed); // YYYY-MM-DD, issuer offset
        if (dVenc > dVencLimit) {
          throw new NFeOrchestratorError(
            `duplicata ${i + 1}: vencimento '${dVenc}' is more than 10 years out ` +
              `(SEFAZ rejection 797) — check pagamento.vencimento`,
          );
        }
        out.dVenc = dVenc;
      }
    }
    return out;
  });

  // Sum the already-rounded per-dup values so fat.vOrig/vLiq equals Σ vDup
  // exactly — summing raw floats then rounding once can drift a cent from the
  // individually-rounded duplicatas.
  const vOrig = dup.reduce((acc, d) => acc + Number(d.vDup), 0);
  const nFat = (dups[0]?.nFat ?? '').trim() || dup[0]?.nDup || undefined;
  const fat: { nFat?: string; vOrig?: string; vDesc?: string; vLiq?: string } = {
    vOrig: vOrig.toFixed(2),
    vDesc: (0).toFixed(2),
    vLiq: vOrig.toFixed(2),
  };
  if (nFat) fat.nFat = nFat;
  return { fat, dup };
}

/**
 * Build the `<infAdic>` block by concatenating `pedido.infCpl` with
 * `operacao.infCpl` (in that order, separated by a space). Returns
 * undefined when both are empty so the orchestrator omits the block.
 * Mirror of Flutter `pedido_nfe_base.dart:538-546`.
 */
export function buildInfAdic(
  pedido: PedidoBundle['pedido'],
  operacao: Operacao,
): { infCpl?: string } | undefined {
  const pedidoCpl =
    typeof (pedido as { infCpl?: unknown }).infCpl === 'string'
      ? (pedido as { infCpl: string }).infCpl.trim()
      : '';
  const operacaoCpl = (operacao.infCpl ?? '').trim();
  const parts = [pedidoCpl, operacaoCpl].filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  return { infCpl: parts.join(' ') };
}

/**
 * Build the `<exporta>` block when the operação is an export (idDest=3
 * on the wire — driven here by `operacao.ehExterior === true`).
 * `UFSaidaPais` is the UF the goods leave Brazil through (defaults to
 * the filial's UF); `xLocExporta` is the customs city (default: filial
 * city). Returns undefined for domestic operations.
 */
export function buildExporta(
  operacao: Operacao,
  filial: Filial,
):
  | {
      UFSaidaPais:
        | 'AC'
        | 'AL'
        | 'AM'
        | 'AP'
        | 'BA'
        | 'CE'
        | 'DF'
        | 'ES'
        | 'GO'
        | 'MA'
        | 'MG'
        | 'MS'
        | 'MT'
        | 'PA'
        | 'PB'
        | 'PE'
        | 'PI'
        | 'PR'
        | 'RJ'
        | 'RN'
        | 'RO'
        | 'RR'
        | 'RS'
        | 'SC'
        | 'SE'
        | 'SP'
        | 'TO';
      xLocExporta: string;
      xLocDespacho?: string;
    }
  | undefined {
  if (!operacao.ehExterior) return undefined;
  const ufRaw = filial.sede.estado;
  if (ufRaw === 'EX') {
    // 'EX' is the foreign-carrier placeholder used inside <transporta>,
    // not a valid emitter UF — SEFAZ rejects `<emit><enderEmit><UF>EX`.
    throw new NFeOrchestratorError(
      `filial.sede.estado='EX' is not a valid emitter UF for an export operation`,
    );
  }
  const cityRaw = sanitizeNFeText(filial.sede.cidade, 60);
  if (!cityRaw) {
    throw new NFeOrchestratorError(`pedido marked ehExterior=true but filial.sede.cidade is empty`);
  }
  return {
    UFSaidaPais: ufRaw,
    xLocExporta: cityRaw,
  };
}

/**
 * Build the `<infIntermed>` block from the loaded Integracao doc.
 * Mirror of Flutter `pedido_nfe_base.dart:523-536`. SEFAZ requires
 * both `CNPJ` and `idCadIntTran` when the operação flags
 * `indIntermed='1'`; missing either is a hard error here so the
 * operator fixes the Integracao record before SEFAZ rejects.
 */
export function buildInfIntermed(
  integracao: Integracao | null,
  operacao: Operacao,
): { CNPJ: string; idCadIntTran: string } | undefined {
  if (operacao.indIntermed !== IND_INTERMED_OPERACAO.plataformaTerceiros) return undefined;
  if (!integracao) {
    throw new NFeOrchestratorError(
      `operacao.indIntermed='1' but no Integracao doc resolved — set ` +
        `pedido.integracaoPedidoOuterRef to a valid Integracao path.`,
    );
  }
  if (!integracao.cpf_cnpj || !integracao.idCadIntTran) {
    throw new NFeOrchestratorError(
      `<infIntermed> requires both Integracao.cpf_cnpj and Integracao.idCadIntTran ` +
        `(SEFAZ NT 2020.006); got cpf_cnpj='${integracao.cpf_cnpj ?? ''}', ` +
        `idCadIntTran='${integracao.idCadIntTran ?? ''}'`,
    );
  }
  return {
    CNPJ: integracao.cpf_cnpj,
    idCadIntTran: integracao.idCadIntTran,
  };
}
