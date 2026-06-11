import {
  aggregateTotals,
  buildImpostoXml,
  buildPagXml,
  buildTotalXml,
  buildTranspXml,
  sanitizeNFeText,
  type GeneratorInput,
  type GeneratorItem,
  type Payment,
} from '@delfrance/integrations-nfe';
import {
  FORMA_PAGAMENTO,
  type Filial,
  type FreteDoPedido,
  type Integracao,
  type Operacao,
  type Pagamento,
} from '@delfrance/schemas';

import type { NFeRuntime } from '../runtime';
import { NFeOrchestratorError } from './errors';
import { round2, type FiscalItem, type PedidoBundle } from './bundle';

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
): GeneratorInput {
  const isInterstate = bundle.enderecoDest.estado !== bundle.filial.sede.estado;
  const genItems = buildGenItems(items, bundle, isInterstate);

  // Compute frete value upfront so it can ride into both the totals
  // aggregator (NF-e level) and onto det[0].prod.vFrete (item level)
  // when the issuer contracts the carrier (modalidade='0').
  const freteEmitente = bundle.frete?.modalidade === '0' && (bundle.frete.valorCobrado ?? 0) > 0;
  const vFrete = freteEmitente ? (bundle.frete!.valorCobrado as number) : 0;
  if (vFrete > 0 && genItems.length > 0) {
    // Mirror of Flutter `pedido_nfe_base.dart:932`: stamp the full frete
    // value onto the first <det>'s <prod>. Phase D could split this
    // proportionally across items; Flutter doesn't.
    const first = genItems[0]!;
    genItems[0] = { ...first, vFrete };
  }

  const totals = aggregateTotals(
    items.map((it) => ({ item: { vProd: it.vProd }, imposto: it.imposto })),
    { vFrete },
  );
  const payments = buildPaymentsFromPagamentos(bundle.pagamentos, {
    vNF: totals.vNF,
    frete: bundle.frete,
  });

  const transpOpts = buildTranspFromFrete(bundle.frete);
  const cobr = buildCobrFromPagamentos(bundle.pagamentos);
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
): GeneratorItem[] {
  const cfopField = isInterstate ? 'cfopInterestadual' : 'cfop';
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
      vProd: it.vProd,
      cEANTrib: cEAN,
      uTrib: unidade,
      qTrib: it.quantidade,
      vUnTrib: it.precoDeVenda,
      indTot: '1',
      impostoXml: buildImpostoXml(it.imposto, { vProd: it.vProd }),
    };
  });
}

/**
 * Project filtered Pagamentos into typed `Payment` entries — mirrors
 * Flutter's `pedido_nfe_base.dart:1766` (`get pag`) field-for-field:
 *
 *   - empty list → single `tPag='90'` (sem pagamento), `vPag=0` (Flutter's
 *     `1768–1776` default — SEFAZ-safe, no `<xPag>` needed).
 *   - per Pagamento: `tPag` = `forma_de_pagamento` padded to 2 digits;
 *     `vPag` = `valor + juros` (or 0 when `forma=90`); `indPag` from
 *     `aVista` (0=à vista, 1=a prazo).
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
    pagamentos.length === 1 && ctx.frete?.modalidade === '0' && (ctx.frete.valorCobrado ?? 0) > 0;

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
      vPag = p.valor + (p.juros ?? 0);
    }
    const indPag: NonNullable<Payment['indPag']> = p.aVista ? '0' : '1';

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
  if (frete == null || frete.modalidade === '9') {
    return { modFrete: '9' };
  }
  const out: ReturnType<typeof buildTranspFromFrete> = { modFrete: frete.modalidade };

  if (frete.transportadora) {
    const t = frete.transportadora;
    const transporta: NonNullable<typeof out.transporta> = {};
    if (typeof t.CNPJ === 'string' && t.CNPJ) transporta.CNPJ = t.CNPJ;
    else if (typeof t.CPF === 'string' && t.CPF) transporta.CPF = t.CPF;
    const xNome = sanitizeNFeText(t.xNome, 60);
    if (xNome) transporta.xNome = xNome;
    if (typeof t.IE === 'string' && t.IE) transporta.IE = t.IE;
    const xEnder = sanitizeNFeText(t.xEnder, 60);
    if (xEnder) transporta.xEnder = xEnder;
    const xMun = sanitizeNFeText(t.xMun, 60);
    if (xMun) transporta.xMun = xMun;
    if (typeof t.UF === 'string' && t.UF) {
      transporta.UF = t.UF as NonNullable<typeof transporta.UF>;
    }
    if (Object.keys(transporta).length > 0) out.transporta = transporta;
  }

  if (frete.veiculo?.placa) {
    out.veicTransp = {
      placa: frete.veiculo.placa,
      ...(frete.veiculo.UF
        ? { UF: frete.veiculo.UF as NonNullable<typeof out.veicTransp>['UF'] }
        : {}),
      ...(frete.veiculo.RNTC ? { RNTC: frete.veiculo.RNTC } : {}),
    };
  }

  if (frete.reboques && frete.reboques.length > 0) {
    const reboques = frete.reboques
      .filter((r) => typeof r.placa === 'string' && r.placa)
      .map((r) => ({
        placa: r.placa as string,
        ...(r.UF ? { UF: r.UF as NonNullable<typeof out.veicTransp>['UF'] } : {}),
        ...(r.RNTC ? { RNTC: r.RNTC } : {}),
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
 * SEFAZ cross-validates `fat.vLiq + Σ dup.vDup === Σ pag.vPag` on the
 * NF-e (catalog rule). We don't try to be clever — if math drifts we
 * surface a clear NFeOrchestratorError so the operator sees it before
 * SEFAZ does. Phase A doesn't apply `vDesc` at the fatura level.
 */
export function buildCobrFromPagamentos(pagamentos: ReadonlyArray<Pagamento>):
  | {
      fat?: { nFat?: string; vOrig?: string; vDesc?: string; vLiq?: string };
      dup?: ReadonlyArray<{ nDup?: string; dVenc?: string; vDup: string }>;
    }
  | undefined {
  const dups = pagamentos.filter((p) => p.duplicata === true);
  if (dups.length === 0) return undefined;

  const dup = dups.map((p, i) => {
    const valor = p.valor + (p.juros ?? 0);
    const out: { nDup?: string; dVenc?: string; vDup: string } = {
      vDup: valor.toFixed(2),
    };
    out.nDup = String(i + 1).padStart(3, '0');
    if (p.vencimento) {
      // pagamento.vencimento is `z.string().datetime()` (ISO timestamp).
      const parsed = new Date(p.vencimento);
      if (!Number.isNaN(parsed.getTime())) {
        out.dVenc = parsed.toISOString().slice(0, 10); // YYYY-MM-DD
      }
    }
    return out;
  });

  const vOrig = dups.reduce((acc, p) => acc + p.valor + (p.juros ?? 0), 0);
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
  if (operacao.indIntermed !== '1') return undefined;
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
