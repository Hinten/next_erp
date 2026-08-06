/**
 * CEP (Brazilian postal code) string helpers — pure, dependency-free, and safe
 * in both the browser and Node.
 *
 * The canonical stored form is the CLEAN 8 digits (`enderecoSchema.cep` is
 * `z.string().regex(/^\d{8}$/)`); the `#####-###` form is display only.
 */

/** Strip every non-digit and keep at most the leading 8 digits. */
export function cleanCep(input: string | null | undefined): string {
  if (input == null) return '';
  return input.replace(/\D/g, '').slice(0, 8);
}

/** True when `input` carries a full 8-digit CEP (accepts a formatted value). */
export function isCepCompleto(input: string | null | undefined): boolean {
  return cleanCep(input).length === 8;
}

/**
 * Display mask `#####-###` over a clean value. Partial input is passed through
 * as far as it goes, so this is safe to run on every keystroke.
 */
export function formatCep(input: string | null | undefined): string {
  const digits = cleanCep(input);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}
