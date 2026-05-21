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
} from '../types/nfe-schema';
import { fmtMoney, round2 } from './format';
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
}

/**
 * Aggregate per-item values into the ICMSTot bag. The bag is then
 * serialised by `buildTotalXml`.
 */
export function aggregateTotals(items: ReadonlyArray<PerItem>): TotalAggregation {
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

  const vNF = round2(vProd + vST + vFCPST);
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
    vFrete: 0,
    vSeg: 0,
    vDesc: 0,
    vII: 0,
    vIPI: 0,
    vIPIDevol: 0,
    vPIS: 0,
    vCOFINS: 0,
    vOutro: 0,
    vNF,
  };
}

/**
 * Build the typed `<total>` value. Every ICMSTot field is required
 * by the XSD; the META walker emits them in XSD order. Use
 * `buildTotalXml` to emit the wire XML; this overload is the typed
 * entry point for consumers that want to plug the result into a
 * larger value (DANFE renderer, fiscal audit, …).
 */
export function buildTotalObject(totals: TotalAggregation): TNFe_infNFe_total {
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
  return { ICMSTot };
}

/**
 * Emit the `<total>` XML block from a `TotalAggregation`. Element
 * ordering and text escaping are owned by `serializeFragment`'s
 * META-driven walker (same path used by `ide` / `emit` / `dest`).
 */
export function buildTotalXml(totals: TotalAggregation): string {
  return serializeFragment(
    'TNFe_infNFe_total',
    'total',
    buildTotalObject(totals) as unknown as XmlValue,
  );
}
