/**
 * `<total>` builder — real ICMSTot aggregation.
 *
 * Sums per-item values from the validated tribute inputs. For Simples
 * Nacional under CSOSN 102/103/300/400/500, the ICMS values are zero
 * (the operation isn't an ICMS-debit transaction); for CSOSN 101/201
 * we accumulate vBC + vICMS from the inputs. ICMS-ST values come from
 * the relevant SN201/202/203/500/900 sub-configs.
 *
 * Mirrors the Flutter aggregation in
 * `.old/packages/pedido_nfe/lib/src/pedido_nfe_base.dart:276-296`
 * (the bag of vBC_ICMSTot, vICMS_ICMSTot, … doubles).
 */
import { serializeFragment, type XmlValue } from '../xml';
import type {
  TNFe_infNFe_total,
  TNFe_infNFe_total_ICMSTot,
  TNFe_infNFe_total_ISSQNtot,
  TNFe_infNFe_total_retTrib,
} from '../types/nfe-schema';
import { fmtMoney, fmtMoneyOpt, round2 } from './format';

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
  readonly item: TributeItem;
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
): TotalAggregation {
  let vProd = 0;
  let vBC = 0;
  let vICMS = 0;
  let vBCST = 0;
  let vST = 0;
  let vFCPST = 0;
  let vFCPSTRet = 0;
  let vIPI = 0;

  for (const { item, imposto } of items) {
    vProd += item.vProd;
    if (imposto.configuracaoIPI?.vIPI != null) {
      vIPI += imposto.configuracaoIPI.vIPI;
    }
    const icms = imposto.configuracaoICMS;
    if (icms == null) continue; // ISSQN-only item — no ICMS contribution
    if (icms.csosn === '101' && icms.csosn101) {
      vICMS += icms.csosn101.vCredICMSSN;
    } else if (icms.csosn === '201' && icms.csosn201) {
      vICMS += icms.csosn201.vCredICMSSN;
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
  const vNF = round2(vProd + vST + vFCPST + vFrete + vSeg + vOutro + vIPI - vDesc);
  return {
    vBC: round2(vBC),
    vICMS: round2(vICMS),
    vICMSDeson: 0,
    vFCP: 0,
    vBCST: round2(vBCST),
    vST: round2(vST),
    vFCPST: round2(vFCPST),
    vFCPSTRet: round2(vFCPSTRet),
    vProd: round2(vProd),
    vFrete: round2(vFrete),
    vSeg: round2(vSeg),
    vDesc: round2(vDesc),
    vII: 0,
    vIPI: round2(vIPI),
    vIPIDevol: 0,
    vPIS: 0,
    vCOFINS: 0,
    vOutro: round2(vOutro),
    vNF,
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
    vServ: fmtMoney('vServ', round2(vServ)),
    vBC: fmtMoney('vBC', round2(vBC)),
    vISS: fmtMoney('vISS', round2(vISS)),
    dCompet: extras.dCompet,
  };
  if (vDeducao > 0) out.vDeducao = fmtMoney('vDeducao', round2(vDeducao));
  if (vDescIncond > 0) out.vDescIncond = fmtMoney('vDescIncond', round2(vDescIncond));
  if (vDescCond > 0) out.vDescCond = fmtMoney('vDescCond', round2(vDescCond));
  if (vISSRet > 0) out.vISSRet = fmtMoney('vISSRet', round2(vISSRet));
  if (vOutro > 0) out.vOutro = fmtMoney('vOutro', round2(vOutro));
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
  if (vRetPIS > 0) out.vRetPIS = fmtMoney('vRetPIS', round2(vRetPIS));
  if (vRetCOFINS > 0) out.vRetCOFINS = fmtMoney('vRetCOFINS', round2(vRetCOFINS));
  if (vRetCSLL > 0) out.vRetCSLL = fmtMoney('vRetCSLL', round2(vRetCSLL));
  if (vBCIRRF > 0) out.vBCIRRF = fmtMoney('vBCIRRF', round2(vBCIRRF));
  if (vIRRF > 0) out.vIRRF = fmtMoney('vIRRF', round2(vIRRF));
  if (vBCRetPrev > 0) out.vBCRetPrev = fmtMoney('vBCRetPrev', round2(vBCRetPrev));
  if (vRetPrev > 0) out.vRetPrev = fmtMoney('vRetPrev', round2(vRetPrev));
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
