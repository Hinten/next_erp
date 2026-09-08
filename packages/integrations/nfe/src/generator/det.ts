/**
 * `infNFe.det[]` — per-item assembly.
 *
 * Per-det layout is `<det nItem="N"><prod>...</prod><imposto>...</imposto></det>`.
 * The `prod` group goes through the META-driven XML serializer; the `imposto`
 * sub-tree arrives pre-built from the caller and is spliced in raw (tributary
 * computation is intentionally out of scope for Phase A — see the plan).
 */
import { validateCNPJ } from '@delfrance/core/documents';
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

/**
 * `det.prod.CNPJFab` is XSD type `TCnpj` — `[0-9]{14}`, digits only — and MOC
 * 7.0 Anexo I I05e-20 (Obrigatória) rejects an invalid one with **489** ("CNPJ
 * informado inválido (DV ou zeros)").
 *
 * ⚠️ Nothing upstream constrains it. `filial.cnpj` and `cliente.cpf_cnpj` carry
 * their own regexes in the schemas, which is why `buildEmit`/`buildDest` may
 * emit those raw; `CNPJFab` is a bare `z.string()` on all four tax schemas and
 * the Impostos tab renders it as an unmasked `TextInput`, so a cadastro can
 * legitimately hold `12.345.678/0001-99`. Normalise then validate, the same
 * shape as `requireIeDigits` in ./parties — forgiving about punctuation, strict
 * about content — because the alternative is a rejection on a note that has
 * already consumed a número and been signed.
 */
function requireCnpjFab(raw: string | undefined, nItem: number): string {
  if (!raw) {
    throw new NFeDetError(
      `item ${nItem}: indEscala='N' (produção em escala NÃO relevante) requires CNPJFab ` +
        `— MOC Anexo I I05e-10, SEFAZ rejeição 879. Fill "CNPJ do fabricante" on the ` +
        `produto's Impostos tab, or clear "Indicador de escala".`,
    );
  }
  const digits = raw.replace(/\D/g, '');
  if (!/^\d{14}$/.test(digits) || !validateCNPJ(digits)) {
    throw new NFeDetError(
      `item ${nItem}: CNPJFab='${raw}' is not a valid CNPJ (expected 14 digits with a ` +
        `correct DV, got '${digits}') — SEFAZ rejeição 489. Fix the produto's Impostos tab.`,
    );
  }
  return digits;
}

/** `det.prod.cBenef` — `([!-ÿ]{8}|[!-ÿ]{10}|SEM CBENEF)?` (leiauteNFe_v4.00.xsd:967). */
function requireCBenef(raw: string, nItem: number): string {
  const value = raw.trim();
  if (!/^([!-ÿ]{8}|[!-ÿ]{10}|SEM CBENEF)$/.test(value)) {
    throw new NFeDetError(
      `item ${nItem}: cBenef='${raw}' must be 8 or 10 characters, or the literal ` +
        `'SEM CBENEF'. Fix the produto's Impostos tab.`,
    );
  }
  return value;
}

/** `det.prod.EXTIPI` — `[0-9]{2,3}` (leiauteNFe_v4.00.xsd:1013). */
function requireExtipi(raw: string, nItem: number): string {
  const value = raw.trim();
  if (!/^[0-9]{2,3}$/.test(value)) {
    throw new NFeDetError(
      `item ${nItem}: EXTIPI='${raw}' must be 2 or 3 digits (código EX da TIPI). ` +
        `Fix the produto's Impostos tab.`,
    );
  }
  return value;
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
    // relevante" (XSD annotation) — read in BOTH directions. Flutter gated it on
    // `indEscala != null`, emitting it alongside an 'S' where the field has no
    // meaning; and the annotation's other half is a hard rule, not a hint:
    // MOC 7.0 Anexo I I05e-10 (Obrigatória) → **rejeição 879**, "Informado item
    // 'Produzido em Escala NÃO Relevante' e não informado CNPJ do Fabricante".
    // `CNPJFab` is `minOccurs="0"`, so the pre-send `validateXsd` cannot catch
    // that combination — without this throw the note is numbered, signed and
    // transmitted before SEFAZ says no.
    if (item.indEscala === false) {
      prod.CNPJFab = requireCnpjFab(item.CNPJFab, item.nItem);
    }
  }
  if (item.cBenef) prod.cBenef = requireCBenef(item.cBenef, item.nItem);
  if (item.EXTIPI) prod.EXTIPI = requireExtipi(item.EXTIPI, item.nItem);
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
