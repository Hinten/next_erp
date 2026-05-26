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
 * − vDesc`, mirroring Flutter `pedido_nfe_base.dart:1729` and the
 * SEFAZ formula for `<vNF>` (NT 2018.005).
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

  for (const { item, imposto } of items) {
    vProd += item.vProd;
    const icms = imposto.configuracaoICMS;
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
  const vNF = round2(vProd + vST + vFCPST + vFrete + vSeg + vOutro - vDesc);
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
    vIPI: 0,
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
 * **Group B placeholder**: returns `undefined` until `impostoSchema`
 * gains `configuracaoISSQN` (per the parity plan). Phase A retail
 * (CSOSN 102 + mercadoria) never carries ISSQN, so this is harmless
 * until the schema lands.
 */
export function aggregateISSQN(
  _items: ReadonlyArray<PerItem>,
): TNFe_infNFe_total_ISSQNtot | undefined {
  return undefined;
}

/**
 * Aggregate per-item retentions into the optional `<retTrib>` block.
 *
 * **Group B placeholder**: returns `undefined` until `impostoSchema`
 * gains the retention fields. Same rationale as `aggregateISSQN`.
 */
export function aggregateRetTrib(
  _items: ReadonlyArray<PerItem>,
): TNFe_infNFe_total_retTrib | undefined {
  return undefined;
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
