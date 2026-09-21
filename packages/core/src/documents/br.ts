import type { DocumentProvider } from './index';

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Strip the usual document punctuation (dots, dash, slash, spaces) and
 * uppercase. Unlike `digitsOnly` this keeps letters — required for the
 * alphanumeric CNPJ (IN RFB 2.229/2024: the 12 root+order positions may be
 * letters or digits; the 2 check digits stay numeric).
 *
 * This is the canonical stored form: `clienteSchema.cpf_cnpj` is
 * `.regex(/^[0-9A-Z]*$/)`, so a punctuated value does not even round-trip the
 * schema. It is also the ONLY form a `cpf_cnpj` equality lookup may query —
 * comparing a raw value against a stored one is how #786's spurious
 * self-overwrite happened.
 */
export function normalizeDocumento(value: string): string {
  return value.replace(/[.\-/\s]/g, '').toUpperCase();
}

/**
 * Validate a CPF using the standard mod-11 checksum with the canonical
 * weights (10..2 for the first DV, 11..2 for the second). Reject the
 * known degenerate inputs (all-same-digit). Accepts 11-digit strings.
 */
export function validateCPF(input: string): boolean {
  const cpf = digitsOnly(input);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const compute = (slice: number): number => {
    let sum = 0;
    for (let i = 0; i < slice; i++) {
      sum += Number(cpf[i]) * (slice + 1 - i);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };

  return compute(9) === Number(cpf[9]) && compute(10) === Number(cpf[10]);
}

/**
 * Validate a CNPJ (14 chars) using the canonical mod-11 checksum.
 * Weights: [5,4,3,2,9,8,7,6,5,4,3,2] for DV1, prefixed with 6 for DV2.
 *
 * Supports the alphanumeric CNPJ (IN RFB 2.229/2024): the first 12
 * positions may be A-Z or 0-9, the 2 check digits are always numeric, and
 * each char enters the checksum as `charCode - 48` (identical to the digit
 * value for 0-9, so purely numeric CNPJs validate exactly as before).
 */
export function validateCNPJ(input: string): boolean {
  const cnpj = normalizeDocumento(input);
  if (!/^[A-Z0-9]{12}\d{2}$/.test(cnpj)) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const compute = (chars: string, weights: number[]): number => {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += (chars.charCodeAt(i) - 48) * weights[i]!;
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };

  const dv1Weights = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const dv2Weights = [6, ...dv1Weights];

  return (
    compute(cnpj.slice(0, 12), dv1Weights) === Number(cnpj[12]) &&
    compute(cnpj.slice(0, 13), dv2Weights) === Number(cnpj[13])
  );
}

/**
 * Validate a combined CPF/CNPJ field by length: 11 chars → CPF,
 * 14 chars → CNPJ (numeric or alphanumeric), anything else → invalid.
 */
export function validateCpfCnpj(input: string): boolean {
  const cleaned = normalizeDocumento(input);
  if (cleaned.length === 11) return validateCPF(cleaned);
  if (cleaned.length === 14) return validateCNPJ(cleaned);
  return false;
}

export function formatCPF(input: string): string {
  const v = digitsOnly(input).slice(0, 11);
  if (v.length !== 11) return v;
  return `${v.slice(0, 3)}.${v.slice(3, 6)}.${v.slice(6, 9)}-${v.slice(9)}`;
}

export function formatCNPJ(input: string): string {
  const v = normalizeDocumento(input).slice(0, 14);
  if (v.length !== 14) return v;
  return `${v.slice(0, 2)}.${v.slice(2, 5)}.${v.slice(5, 8)}/${v.slice(8, 12)}-${v.slice(12)}`;
}

/**
 * Format a CPF (`000.000.000-00`) or a CNPJ (`00.000.000/0000-00`) from a
 * combined field, by LENGTH after {@link normalizeDocumento} — 11 → CPF,
 * 14 → CNPJ. Anything else is returned exactly as given: a display helper
 * never hides a value it does not understand.
 *
 * ⚠️ The CNPJ mask is positional, never digit-driven, so the alphanumeric CNPJ
 * (RFB IN 2.229/2024) masks correctly: `12ABC678000190` → `12.ABC.678/0001-90`.
 * The three copies this replaces did not agree on that — two of them stripped
 * non-digits first, which mangles an alfa CNPJ into a shorter string.
 * ⚠️ The count is `14 − (letters)`, so what the mangled value LOOKS like varies:
 * `12ABC678000190` has three letters and strips to ELEVEN digits, which a
 * length-driven formatter renders as somebody's CPF, while `12ABC34501DE35` has
 * five and strips to nine, which matches no document at all. Both are wrong; the
 * three-letter arity is the one that produces a plausible-looking lie.
 * Both were green, both were commented, and neither
 * could be diffed against the third by eye (root CLAUDE.md: extract it instead
 * of writing the rule twice).
 *
 * ⚠️ It does NOT validate. `formatCpfCnpj` answers "how is this written down",
 * `validateCpfCnpj` answers "is this a real document"; a screen that needs both
 * asks both, because a display that silently blanks an invalid stored value is
 * how a bad row stops being visible.
 */
export function formatCpfCnpj(value: string): string {
  const v = normalizeDocumento(value.trim());
  if (/^\d{11}$/.test(v)) return formatCPF(v);
  if (/^[A-Z0-9]{12}\d{2}$/.test(v)) return formatCNPJ(v);
  return value;
}

export const brDocumentProvider: DocumentProvider = {
  id: 'br',
  validateIndividual: validateCPF,
  validateBusiness: validateCNPJ,
  formatIndividual: formatCPF,
  formatBusiness: formatCNPJ,
};
