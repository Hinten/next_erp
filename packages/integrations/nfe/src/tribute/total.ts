/**
 * `<total>` builder — real ICMSTot aggregation.
 *
 * Sums per-item values from the validated tribute inputs. For Simples
 * Nacional the ICMS-debit total (vBC/vICMS) is zero for every CSOSN except
 * 900 (the only SN code that carries a real vICMS); CSOSN 101/201's
 * `vCredICMSSN` is the buyer's transferable credit, NOT emitter ICMS, so it
 * never rolls into ICMSTot. ICMS-ST values come from the SN201/202/203/500/900
 * sub-configs.
 *
 * Mirrors the Flutter aggregation in
 * `.old/packages/pedido_nfe/lib/src/pedido_nfe_base.dart:276-296`
 * (the bag of vBC_ICMSTot, vICMS_ICMSTot, … doubles).
 */
import { serializeFragment, type XmlValue } from '../xml';
import type {
  TIBSCBSMonoTot,
  TISTot,
  TNFe_infNFe_total,
  TNFe_infNFe_total_ICMSTot,
  TNFe_infNFe_total_ISSQNtot,
  TNFe_infNFe_total_retTrib,
} from '../types/nfe-schema';
import { fmtMoney, fmtMoneyOpt, roundReais } from './format';
import { IPI_TRIB_CSTS } from './schemas';
import { computeRtcItemValues, parseRtcConfig } from './rtc';

/**
 * Whole-NF-e values needed by aggregateISSQN that aren't derivable
 * from per-item imposto — today: `dCompet` (competence date, XSD-required
 * on `<ISSQNtot>`, YYYY-MM-DD).
 */
export interface ISSQNExtras {
  readonly dCompet: string;
  readonly cRegTrib?: '1' | '2' | '3' | '4' | '5' | '6';
}
import type { Imposto, TributeItem } from './schemas';

interface PerItem {
  /**
   * `item.vProd` is the GROSS product value (summed into `ICMSTot.vProd`, which
   * must equal Σ wire `<prod><vProd>`). `item.vBaseTributavel`, when present, is
   * the net-of-discount tribute base used for the RTC (IBS/CBS/IS) computation —
   * it must match the base the per-item `buildImpostoXml` used, so item and total
   * RTC values agree. Defaults to `vProd` (no discount). The pedido-level and
   * per-item discounts flow into the total via `TotalExtras.vDesc`.
   */
  readonly item: TributeItem & { readonly vBaseTributavel?: number };
  readonly imposto: Imposto;
}

export interface TotalAggregation {
  readonly vBC: number;
  readonly vICMS: number;
  readonly vICMSDeson: number;
  readonly vFCP: number;
  readonly vBCST: number;
  readonly vST: number;
  readonly vFCPST: number;
  readonly vFCPSTRet: number;
  readonly vProd: number;
  readonly vFrete: number;
  readonly vSeg: number;
  readonly vDesc: number;
  readonly vII: number;
  readonly vIPI: number;
  readonly vIPIDevol: number;
  readonly vPIS: number;
  readonly vCOFINS: number;
  readonly vOutro: number;
  readonly vNF: number;
  // Optional ICMSTot fields — present only when relevant data is on
  // the NF-e. The XSD makes each `<vXxx>` element optional; the META
  // serializer omits anything left null/undefined.
  readonly vTotTrib?: number;
  readonly vFCPUFDest?: number;
  readonly vICMSUFDest?: number;
  readonly vICMSUFRemet?: number;
  /**
   * Reforma Tributária (IBS/CBS/IS) totals — present only when
   * `aggregateTotals` ran with `{ emitRtc: true }` AND at least one item
   * carried `configuracaoIBSCBS`. Drives the `IBSCBSTot` / `ISTot` /
   * `vNFTot` groups in `buildTotalObject`. `vNF` (ICMSTot) is never affected.
   */
  readonly rtc?: RtcTotalSummary;
}

/** Summed per-item RTC values for the total-level `IBSCBSTot` / `ISTot`. */
export interface RtcTotalSummary {
  readonly vBCIBSCBS: number;
  readonly vIBSUF: number;
  readonly vIBSMun: number;
  readonly vIBS: number;
  readonly vCBS: number;
  readonly vIS: number;
}

/**
 * Whole-NF-e values that are NOT derivable from per-item imposto.
 * Today: vFrete (only when frete.modalidade='0'), vSeg (insurance),
 * vDesc (pedido-level discount), vOutro (catch-all).
 */
export interface TotalExtras {
  readonly vFrete?: number;
  readonly vSeg?: number;
  readonly vDesc?: number;
  readonly vOutro?: number;
}

/**
 * Aggregate per-item values into the ICMSTot bag. The bag is then
 * serialised by `buildTotalXml`. `extras` carries the whole-NF-e
 * values (frete, insurance, …) the orchestrator computes from
 * non-item sources (`pedido.freteInicial`, etc.).
 *
 * vNF is computed as `vProd + vST + vFCPST + vFrete + vSeg + vOutro
 * + vIPI − vDesc`, mirroring Flutter `pedido_nfe_base.dart:1729` and
 * the SEFAZ formula for `<vNF>` (NT 2018.005).
 */
export function aggregateTotals(
  items: ReadonlyArray<PerItem>,
  extras: TotalExtras = {},
  opts: { emitRtc?: boolean } = {},
): TotalAggregation {
  let vProd = 0;
  let vBC = 0;
  let vICMS = 0;
  let vBCST = 0;
  let vST = 0;
  let vFCPST = 0;
  let vFCPSTRet = 0;
  let vIPI = 0;
  // RTC (IBS/CBS/IS) accumulators — populated only with `{ emitRtc: true }`.
  let rtcBC = 0;
  let rtcIBSUF = 0;
  let rtcIBSMun = 0;
  let rtcIBS = 0;
  let rtcCBS = 0;
  let rtcIS = 0;
  let rtcCount = 0;

  for (const { item, imposto } of items) {
    vProd += item.vProd;
    // RTC runs for every item (incl. ISSQN-only) before the ICMS `continue`.
    // Base = the net-of-discount tribute value (matches the per-item
    // `buildImpostoXml` base), NOT the gross `vProd` accumulated above.
    if (opts.emitRtc && imposto.configuracaoIBSCBS != null) {
      const rtcBase = item.vBaseTributavel ?? item.vProd;
      const r = computeRtcItemValues(parseRtcConfig(imposto.configuracaoIBSCBS), rtcBase);
      rtcBC += r.vBC;
      rtcIBSUF += r.vIBSUF;
      rtcIBSMun += r.vIBSMun;
      rtcIBS += r.vIBS;
      rtcCBS += r.vCBS;
      rtcIS += r.vIS;
      rtcCount += 1;
    }
    // Only IPITrib CSTs (00/49/50/99) actually emit <vIPI> per item; IPINT CSTs
    // carry a stored vIPI in some legacy configs but emit nothing, so counting it
    // would make ICMSTot.vIPI > Σ item vIPI. Mirror buildIPI's IPI_TRIB_CSTS gate.
    if (imposto.configuracaoIPI?.vIPI != null && IPI_TRIB_CSTS.has(imposto.configuracaoIPI.CST)) {
      vIPI += imposto.configuracaoIPI.vIPI;
    }
    const icms = imposto.configuracaoICMS;
    // ISSQN-only item — no ICMS contribution. An item carrying <ISSQN> emits NO
    // <ICMS> (xs:choice; buildImpostoXml drops the ICMS config when ISSQN is set),
    // so its ICMS/ST config must NOT roll into the totals — otherwise ICMSTot
    // carries vICMS/vBCST/vST no item ever emitted (a totals mismatch SEFAZ rejects).
    if (icms == null || imposto.configuracaoISSQN != null) continue;
    // CSOSN 101/201 contribute NOTHING to ICMSTot.vBC/vICMS. `vCredICMSSN` is
    // the Simples Nacional transferable credit (LC 123/2006 art. 23) that the
    // buyer may appropriate — it is not ICMS debited by the emitter, and the
    // ICMSSN101/ICMSSN201 item groups carry no <vICMS> element. Adding it here
    // makes ICMSTot.vICMS > Σ item vICMS (which is 0), which SEFAZ rejects with
    // cStat 532 ("Total do ICMS difere do somatório dos itens", MOC 7.0 Anexo I
    // W04). Only CSOSN 900's real <vICMS> rolls up (below). Matches the legacy
    // Flutter engine, whose vICMS_ICMSTot stays 0 for SN-credit notes.
    if (icms.csosn === '201' && icms.csosn201) {
      vBCST += icms.csosn201.vBCST;
      vST += icms.csosn201.vICMSST;
      vFCPST += icms.csosn201.vFCPST ?? 0;
    } else if ((icms.csosn === '202' || icms.csosn === '203') && icms.csosn202ou203) {
      vBCST += icms.csosn202ou203.vBCST;
      vST += icms.csosn202ou203.vICMSST;
      vFCPST += icms.csosn202ou203.vFCPST ?? 0;
    } else if (icms.csosn === '500' && icms.csosn500) {
      vFCPSTRet += icms.csosn500.vFCPSTRet ?? 0;
    } else if (icms.csosn === '900' && icms.csosn900) {
      vBC += icms.csosn900.vBC ?? 0;
      vICMS += icms.csosn900.vICMS ?? 0;
      vBCST += icms.csosn900.vBCST ?? 0;
      vST += icms.csosn900.vICMSST ?? 0;
      vFCPST += icms.csosn900.vFCPST ?? 0;
    }
    // CSOSN 102/103/300/400 add nothing to the ICMS bucket.
  }

  const vFrete = extras.vFrete ?? 0;
  const vSeg = extras.vSeg ?? 0;
  const vDesc = extras.vDesc ?? 0;
  const vOutro = extras.vOutro ?? 0;
  const vNF = roundReais(vProd + vST + vFCPST + vFrete + vSeg + vOutro + vIPI - vDesc);
  return {
    vBC: roundReais(vBC),
    vICMS: roundReais(vICMS),
    vICMSDeson: 0,
    vFCP: 0,
    vBCST: roundReais(vBCST),
    vST: roundReais(vST),
    vFCPST: roundReais(vFCPST),
    vFCPSTRet: roundReais(vFCPSTRet),
    vProd: roundReais(vProd),
    vFrete: roundReais(vFrete),
    vSeg: roundReais(vSeg),
    vDesc: roundReais(vDesc),
    vII: 0,
    vIPI: roundReais(vIPI),
    vIPIDevol: 0,
    vPIS: 0,
    vCOFINS: 0,
    vOutro: roundReais(vOutro),
    vNF,
    ...(opts.emitRtc && rtcCount > 0
      ? {
          rtc: {
            vBCIBSCBS: roundReais(rtcBC),
            vIBSUF: roundReais(rtcIBSUF),
            vIBSMun: roundReais(rtcIBSMun),
            vIBS: roundReais(rtcIBS),
            vCBS: roundReais(rtcCBS),
            vIS: roundReais(rtcIS),
          },
        }
      : {}),
  };
}

/**
 * Aggregate per-item ISSQN values into the optional `<ISSQNtot>` block.
 *
 * Returns `undefined` when no item carries `configuracaoISSQN` (the
 * common case for retail). When at least one item is ISSQN, `extras.dCompet`
 * is required by the XSD — the orchestrator threads it in from the
 * emission date.
 *
 * vServ is the sum of `item.vProd` for ISSQN items (per Lei Complementar
 * 116/2003 — service revenue, not merchandise). The rest are summed
 * directly off `configuracaoISSQN` fields.
 */
export function aggregateISSQN(
  items: ReadonlyArray<PerItem>,
  extras?: ISSQNExtras,
): TNFe_infNFe_total_ISSQNtot | undefined {
  const issqnItems = items.filter((p) => p.imposto.configuracaoISSQN != null);
  if (issqnItems.length === 0) return undefined;
  if (extras == null) {
    throw new Error('aggregateISSQN: extras.dCompet is required when items carry ISSQN');
  }

  let vServ = 0;
  let vBC = 0;
  let vISS = 0;
  let vDeducao = 0;
  let vDescIncond = 0;
  let vDescCond = 0;
  let vISSRet = 0;
  let vOutro = 0;

  for (const { item, imposto } of issqnItems) {
    const issqn = imposto.configuracaoISSQN!;
    vServ += item.vProd;
    vBC += issqn.vBC;
    vISS += issqn.vISSQN;
    vDeducao += issqn.vDeducao ?? 0;
    vDescIncond += issqn.vDescIncond ?? 0;
    vDescCond += issqn.vDescCond ?? 0;
    vISSRet += issqn.vISSRet ?? 0;
    vOutro += issqn.vOutro ?? 0;
  }

  const out: TNFe_infNFe_total_ISSQNtot = {
    vServ: fmtMoney('vServ', roundReais(vServ)),
    vBC: fmtMoney('vBC', roundReais(vBC)),
    vISS: fmtMoney('vISS', roundReais(vISS)),
    dCompet: extras.dCompet,
  };
  if (vDeducao > 0) out.vDeducao = fmtMoney('vDeducao', roundReais(vDeducao));
  if (vDescIncond > 0) out.vDescIncond = fmtMoney('vDescIncond', roundReais(vDescIncond));
  if (vDescCond > 0) out.vDescCond = fmtMoney('vDescCond', roundReais(vDescCond));
  if (vISSRet > 0) out.vISSRet = fmtMoney('vISSRet', roundReais(vISSRet));
  if (vOutro > 0) out.vOutro = fmtMoney('vOutro', roundReais(vOutro));
  if (extras.cRegTrib != null) out.cRegTrib = extras.cRegTrib;
  return out;
}

/**
 * Aggregate per-item retentions into the optional `<retTrib>` block.
 *
 * Sums the 7 SEFAZ-wire fields across every item's `retencao`:
 * vRetPIS, vRetCOFINS, vRetCSLL, vBCIRRF, vIRRF, vBCRetPrev, vRetPrev.
 * Returns `undefined` when no item carries retentions (typical for
 * retail Simples Nacional). Each output field is omitted unless the
 * cumulative sum is > 0 — matches Flutter parity and avoids emitting
 * zeroed-out retentions that confuse SEFAZ downstream.
 */
export function aggregateRetTrib(
  items: ReadonlyArray<PerItem>,
): TNFe_infNFe_total_retTrib | undefined {
  let vRetPIS = 0;
  let vRetCOFINS = 0;
  let vRetCSLL = 0;
  let vBCIRRF = 0;
  let vIRRF = 0;
  let vBCRetPrev = 0;
  let vRetPrev = 0;
  let any = false;

  for (const { imposto } of items) {
    const r = imposto.retencao;
    if (r == null) continue;
    any = true;
    vRetPIS += r.vRetPIS ?? 0;
    vRetCOFINS += r.vRetCOFINS ?? 0;
    vRetCSLL += r.vRetCSLL ?? 0;
    vBCIRRF += r.vBCIRRF ?? 0;
    vIRRF += r.vIRRF ?? 0;
    vBCRetPrev += r.vBCRetPrev ?? 0;
    vRetPrev += r.vRetPrev ?? 0;
  }
  if (!any) return undefined;

  const out: TNFe_infNFe_total_retTrib = {};
  if (vRetPIS > 0) out.vRetPIS = fmtMoney('vRetPIS', roundReais(vRetPIS));
  if (vRetCOFINS > 0) out.vRetCOFINS = fmtMoney('vRetCOFINS', roundReais(vRetCOFINS));
  if (vRetCSLL > 0) out.vRetCSLL = fmtMoney('vRetCSLL', roundReais(vRetCSLL));
  if (vBCIRRF > 0) out.vBCIRRF = fmtMoney('vBCIRRF', roundReais(vBCIRRF));
  if (vIRRF > 0) out.vIRRF = fmtMoney('vIRRF', roundReais(vIRRF));
  if (vBCRetPrev > 0) out.vBCRetPrev = fmtMoney('vBCRetPrev', roundReais(vBCRetPrev));
  if (vRetPrev > 0) out.vRetPrev = fmtMoney('vRetPrev', roundReais(vRetPrev));
  return out;
}

/**
 * Build the typed `<total>` value. Every ICMSTot field is required
 * by the XSD; the META walker emits them in XSD order. Optional
 * `ISSQNtot` and `retTrib` blocks ride alongside when relevant.
 */
export function buildTotalObject(
  totals: TotalAggregation,
  optional: {
    issqnTot?: TNFe_infNFe_total_ISSQNtot;
    retTrib?: TNFe_infNFe_total_retTrib;
  } = {},
): TNFe_infNFe_total {
  const ICMSTot: TNFe_infNFe_total_ICMSTot = {
    vBC: fmtMoney('vBC', totals.vBC),
    vICMS: fmtMoney('vICMS', totals.vICMS),
    vICMSDeson: fmtMoney('vICMSDeson', totals.vICMSDeson),
    vFCP: fmtMoney('vFCP', totals.vFCP),
    vBCST: fmtMoney('vBCST', totals.vBCST),
    vST: fmtMoney('vST', totals.vST),
    vFCPST: fmtMoney('vFCPST', totals.vFCPST),
    vFCPSTRet: fmtMoney('vFCPSTRet', totals.vFCPSTRet),
    vProd: fmtMoney('vProd', totals.vProd),
    vFrete: fmtMoney('vFrete', totals.vFrete),
    vSeg: fmtMoney('vSeg', totals.vSeg),
    vDesc: fmtMoney('vDesc', totals.vDesc),
    vII: fmtMoney('vII', totals.vII),
    vIPI: fmtMoney('vIPI', totals.vIPI),
    vIPIDevol: fmtMoney('vIPIDevol', totals.vIPIDevol),
    vPIS: fmtMoney('vPIS', totals.vPIS),
    vCOFINS: fmtMoney('vCOFINS', totals.vCOFINS),
    vOutro: fmtMoney('vOutro', totals.vOutro),
    vNF: fmtMoney('vNF', totals.vNF),
  };
  const vTotTrib = fmtMoneyOpt('vTotTrib', totals.vTotTrib);
  if (vTotTrib != null) ICMSTot.vTotTrib = vTotTrib;
  const vFCPUFDest = fmtMoneyOpt('vFCPUFDest', totals.vFCPUFDest);
  if (vFCPUFDest != null) ICMSTot.vFCPUFDest = vFCPUFDest;
  const vICMSUFDest = fmtMoneyOpt('vICMSUFDest', totals.vICMSUFDest);
  if (vICMSUFDest != null) ICMSTot.vICMSUFDest = vICMSUFDest;
  const vICMSUFRemet = fmtMoneyOpt('vICMSUFRemet', totals.vICMSUFRemet);
  if (vICMSUFRemet != null) ICMSTot.vICMSUFRemet = vICMSUFRemet;

  const out: TNFe_infNFe_total = { ICMSTot };
  if (optional.issqnTot != null) out.ISSQNtot = optional.issqnTot;
  if (optional.retTrib != null) out.retTrib = optional.retTrib;
  // Reforma Tributária totals (NT 2025.002, Grupo W03). `vNFTot` = `vNF` plus
  // the RTC tributes ("por fora"); `ICMSTot.vNF` stays untouched (the 2025–2026
  // transition rule — RV VB01-10 Exceção 1). The diferimento / crédito-presumido
  // sub-fields are zero in the tributação-integral shape we emit.
  if (totals.rtc != null) {
    const r = totals.rtc;
    const ibsCbsTot: TIBSCBSMonoTot = {
      vBCIBSCBS: fmtMoney('vBCIBSCBS', r.vBCIBSCBS),
      gIBS: {
        gIBSUF: { vDif: '0.00', vDevTrib: '0.00', vIBSUF: fmtMoney('vIBSUF', r.vIBSUF) },
        gIBSMun: { vDif: '0.00', vDevTrib: '0.00', vIBSMun: fmtMoney('vIBSMun', r.vIBSMun) },
        vIBS: fmtMoney('vIBS', r.vIBS),
        vCredPres: '0.00',
        vCredPresCondSus: '0.00',
      },
      gCBS: {
        vDif: '0.00',
        vDevTrib: '0.00',
        vCBS: fmtMoney('vCBS', r.vCBS),
        vCredPres: '0.00',
        vCredPresCondSus: '0.00',
      },
    };
    out.IBSCBSTot = ibsCbsTot;
    if (r.vIS > 0) {
      const isTot: TISTot = { vIS: fmtMoney('vIS', r.vIS) };
      out.ISTot = isTot;
    }
    out.vNFTot = fmtMoney('vNFTot', roundReais(totals.vNF + r.vIBS + r.vCBS + r.vIS));
  }
  return out;
}

/**
 * Emit the `<total>` XML block from a `TotalAggregation`. Element
 * ordering and text escaping are owned by `serializeFragment`'s
 * META-driven walker (same path used by `ide` / `emit` / `dest`).
 */
export function buildTotalXml(
  totals: TotalAggregation,
  optional: {
    issqnTot?: TNFe_infNFe_total_ISSQNtot;
    retTrib?: TNFe_infNFe_total_retTrib;
  } = {},
): string {
  return serializeFragment(
    'TNFe_infNFe_total',
    'total',
    buildTotalObject(totals, optional) as unknown as XmlValue,
  );
}
