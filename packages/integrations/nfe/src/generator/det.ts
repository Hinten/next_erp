/**
 * `infNFe.det[]` — per-item assembly.
 *
 * Per-det layout is `<det nItem="N"><prod>...</prod><imposto>...</imposto></det>`.
 * The `prod` group goes through the META-driven XML serializer; the `imposto`
 * sub-tree arrives pre-built from the caller and is spliced in raw (tributary
 * computation is intentionally out of scope for Phase A — see the plan).
 */
import { sanitizeNFeText, temTextoCorrompido } from '../sanitize';
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
  // Checked on the RAW value: produto descriptions are legacy-written like the
  // endereço is, and `sanitizeNFeText` would launder a lost encoding round-trip
  // into plausible ASCII on its way into the signed XML. `JSON.stringify` for
  // the same reason as `requireIntegro` in ./parties — the value can carry C1
  // control characters that would otherwise be unprintable in the message.
  if (temTextoCorrompido(item.xProd)) {
    throw new NFeDetError(
      `item ${item.nItem}: xProd=${JSON.stringify(item.xProd)} has corrupted text (a lost ` +
        `character-encoding round-trip). Fix the produto cadastro.`,
    );
  }
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
  // The remaining `<prod>` children Flutter emitted
  // (`pedido_nfe_base.dart:938-947`). All optional in the XSD.
  if (item.NVE && item.NVE.length > 0) {
    if (item.NVE.length > 8) {
      throw new NFeDetError(
        `item ${item.nItem}: NVE accepts at most 8 codes, got ${item.NVE.length}`,
      );
    }
    for (const nve of item.NVE) {
      // Validated HERE, not in `impostoSchema`: a parse failure there makes the
      // resolver fall through to a lower tax tier SILENTLY, which is a wrong
      // NF-e. A throw here is loud and names the offending value.
      if (!/^[A-Z]{2}[0-9]{4}$/.test(nve)) {
        throw new NFeDetError(
          `item ${item.nItem}: NVE=${JSON.stringify(nve)} must be 2 uppercase letters ` +
            `followed by 4 digits (ex.: AB1234)`,
        );
      }
    }
    prod.NVE = [...item.NVE];
  }
  // ⚠️ `indEscala` and `CNPJFab` live inside an `<xs:sequence minOccurs="0">`
  // whose FIRST element, `CEST`, is required (leiauteNFe_v4.00.xsd:936-962).
  // Emitting either without a `CEST` is schema-invalid — SEFAZ rejection 215,
  // after signing. The group is optional as a whole, so dropping them is the
  // only valid choice when the produto carries no CEST.
  if (item.indEscala != null && item.CEST) {
    prod.indEscala = item.indEscala ? 'S' : 'N';
    // "CNPJ do Fabricante da Mercadoria, obrigatório para produto em escala NÃO
    // relevante" (XSD annotation) — so it belongs with `indEscala='N'` only.
    // Flutter gated it on `indEscala != null` instead, emitting it alongside an
    // 'S' where the field has no meaning; this follows the XSD.
    if (item.indEscala === false && item.CNPJFab) prod.CNPJFab = item.CNPJFab;
  }
  if (item.cBenef) prod.cBenef = item.cBenef;
  if (item.EXTIPI) prod.EXTIPI = item.EXTIPI;
  // Optional per-item frete value — set by the orchestrator on det[0]
  // when frete.modalidade='0' (contratação por conta do emitente).
  // Mirrors Flutter `pedido_nfe_base.dart:932`.
  if (item.vFrete != null) prod.vFrete = fmtMoney(item.vFrete);
  // Optional per-item discount (`<vDesc>`) — the unit discount plus this item's
  // apportioned share of the pedido-level descontoTotal. `vProd` stays gross
  // (`vUnCom × qCom`); the discount lives here so SEFAZ rule 629 holds. The META
  // serializer places `vDesc` in XSD order (after vFrete/vSeg, before vOutro).
  if (item.vDesc != null && item.vDesc > 0) prod.vDesc = fmtMoney(item.vDesc);
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
