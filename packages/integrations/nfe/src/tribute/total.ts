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

/** Emit the `<total>` XML block from a `TotalAggregation`. */
export function buildTotalXml(totals: TotalAggregation): string {
  // Hand-emit — every field is required by the XSD in a fixed order
  // and they're all simple `xs:string` numerics, so a template is
  // cheaper than going through serializeFragment for 19 fields.
  return (
    '<total><ICMSTot>' +
    `<vBC>${fmtMoney('vBC', totals.vBC)}</vBC>` +
    `<vICMS>${fmtMoney('vICMS', totals.vICMS)}</vICMS>` +
    `<vICMSDeson>${fmtMoney('vICMSDeson', totals.vICMSDeson)}</vICMSDeson>` +
    `<vFCP>${fmtMoney('vFCP', totals.vFCP)}</vFCP>` +
    `<vBCST>${fmtMoney('vBCST', totals.vBCST)}</vBCST>` +
    `<vST>${fmtMoney('vST', totals.vST)}</vST>` +
    `<vFCPST>${fmtMoney('vFCPST', totals.vFCPST)}</vFCPST>` +
    `<vFCPSTRet>${fmtMoney('vFCPSTRet', totals.vFCPSTRet)}</vFCPSTRet>` +
    `<vProd>${fmtMoney('vProd', totals.vProd)}</vProd>` +
    `<vFrete>${fmtMoney('vFrete', totals.vFrete)}</vFrete>` +
    `<vSeg>${fmtMoney('vSeg', totals.vSeg)}</vSeg>` +
    `<vDesc>${fmtMoney('vDesc', totals.vDesc)}</vDesc>` +
    `<vII>${fmtMoney('vII', totals.vII)}</vII>` +
    `<vIPI>${fmtMoney('vIPI', totals.vIPI)}</vIPI>` +
    `<vIPIDevol>${fmtMoney('vIPIDevol', totals.vIPIDevol)}</vIPIDevol>` +
    `<vPIS>${fmtMoney('vPIS', totals.vPIS)}</vPIS>` +
    `<vCOFINS>${fmtMoney('vCOFINS', totals.vCOFINS)}</vCOFINS>` +
    `<vOutro>${fmtMoney('vOutro', totals.vOutro)}</vOutro>` +
    `<vNF>${fmtMoney('vNF', totals.vNF)}</vNF>` +
    '</ICMSTot></total>'
  );
}
