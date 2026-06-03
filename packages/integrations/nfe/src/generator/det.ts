/**
 * `infNFe.det[]` — per-item assembly.
 *
 * Per-det layout is `<det nItem="N"><prod>...</prod><imposto>...</imposto></det>`.
 * The `prod` group goes through the META-driven XML serializer; the `imposto`
 * sub-tree arrives pre-built from the caller and is spliced in raw (tributary
 * computation is intentionally out of scope for Phase A — see the plan).
 */
import { sanitizeNFeText } from '../sanitize';
import type { TNFe_infNFe_det_prod } from '../types/nfe-schema';
import { serializeFragment, type XmlValue } from '../xml';
import type { GeneratorItem } from './types';

export class NFeDetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeDetError';
  }
}

/** Format quantities — up to 4 decimal places, no trailing-zero stripping. */
function fmtQuantity(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    throw new NFeDetError(`quantity must be ≥ 0 and finite, got ${n}`);
  }
  return n.toFixed(4);
}

/** Format unit values — up to 10 decimal places. */
function fmtUnitValue(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    throw new NFeDetError(`unit value must be ≥ 0 and finite, got ${n}`);
  }
  return n.toFixed(10);
}

/** Format monetary totals — 2 decimal places. */
function fmtMoney(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    throw new NFeDetError(`monetary value must be ≥ 0 and finite, got ${n}`);
  }
  return n.toFixed(2);
}

/** Build the `prod` value object for one item. */
export function buildProd(item: GeneratorItem): TNFe_infNFe_det_prod {
  const xProd = sanitizeNFeText(item.xProd);
  if (!xProd) throw new NFeDetError(`item ${item.nItem}: xProd is required`);
  const prod: TNFe_infNFe_det_prod = {
    cProd: item.cProd,
    cEAN: item.cEAN,
    xProd,
    NCM: item.NCM,
    CEST: item.CEST,
    CFOP: item.CFOP,
    uCom: item.uCom,
    qCom: fmtQuantity(item.qCom),
    vUnCom: fmtUnitValue(item.vUnCom),
    vProd: fmtMoney(item.vProd),
    cEANTrib: item.cEANTrib,
    uTrib: item.uTrib,
    qTrib: fmtQuantity(item.qTrib),
    vUnTrib: fmtUnitValue(item.vUnTrib),
    indTot: item.indTot ?? '1',
  };
  // Optional per-item frete value — set by the orchestrator on det[0]
  // when frete.modalidade='0' (contratação por conta do emitente).
  // Mirrors Flutter `pedido_nfe_base.dart:932`.
  if (item.vFrete != null) prod.vFrete = fmtMoney(item.vFrete);
  return prod;
}

/**
 * Serialise the full det entry for one item: `<det nItem="N"><prod>...</prod>
 * <imposto>...</imposto></det>`. The `nItem` attribute is part of `det`'s
 * complex type per the XSD, but the codegen models it as `det[]` (a list
 * without per-element attributes); we hand-render it here.
 */
export function buildDetXml(item: GeneratorItem): string {
  if (!Number.isInteger(item.nItem) || item.nItem < 1) {
    throw new NFeDetError(`nItem must be a positive integer, got ${item.nItem}`);
  }
  // Codegen types don't carry a `[k: string]: unknown` index signature, so
  // the structurally-compatible XmlValue requires an explicit cast.
  const prodXml = serializeFragment(
    'TNFe_infNFe_det_prod',
    'prod',
    buildProd(item) as unknown as XmlValue,
  );
  return `<det nItem="${item.nItem}">${prodXml}${item.impostoXml}</det>`;
}
