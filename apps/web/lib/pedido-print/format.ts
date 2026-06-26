/**
 * Display formatters for the pedido prints (orçamento image/PDF + comum sheet).
 *
 * Money reuses the canonical `formatReais` from `@delfrance/core/money`; the
 * document / CEP / phone formatters are small ports of the Flutter
 * `formatarCpfCnpj` / `formatarCep` / `formatarTelefone` helpers, and `obscure`
 * is the port of `obscurecerString` (mask all but the last N chars) the
 * orçamento uses to hide the customer's full tax id.
 */
import { formatReais } from '@delfrance/core/money';

export { formatReais };

/** Strip everything that is not a digit. */
function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Strip CPF/CNPJ punctuation (`.` `/` `-` and spaces) but keep digits + letters. */
function stripDocPunct(value: string): string {
  return value.replace(/[.\-/\s]/g, '');
}

/**
 * Format a CPF (11 numeric digits → `000.000.000-00`) or CNPJ (14 chars →
 * `00.000.000/0000-00`). The CNPJ mask is applied **positionally**, so the
 * alphanumeric CNPJ (IN RFB 2.229/2024: 12 alphanumeric positions + 2 numeric
 * check digits) formats correctly too (`12ABC678000190 → 12.ABC.678/0001-90`).
 * Anything else (wrong length / shape) is returned unchanged.
 */
export function formatCpfCnpj(raw: string): string {
  const v = stripDocPunct(raw.trim());
  if (/^\d{11}$/.test(v)) {
    return `${v.slice(0, 3)}.${v.slice(3, 6)}.${v.slice(6, 9)}-${v.slice(9, 11)}`;
  }
  if (/^[0-9A-Za-z]{12}\d{2}$/.test(v)) {
    return `${v.slice(0, 2)}.${v.slice(2, 5)}.${v.slice(5, 8)}/${v.slice(8, 12)}-${v.slice(12, 14)}`;
  }
  return raw;
}

/** Format an 8-digit CEP as `00000-000`; anything else is returned unchanged. */
export function formatCep(raw: string): string {
  const digits = onlyDigits(raw);
  if (digits.length === 8) {
    return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  }
  return raw;
}

/**
 * Format a Brazilian phone: 11 digits → `(00) 00000-0000`, 10 digits →
 * `(00) 0000-0000`. Other lengths (e.g. foreign numbers) are returned unchanged.
 */
export function formatTelefone(raw: string): string {
  const digits = onlyDigits(raw);
  if (digits.length === 11) {
    return digits.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
  }
  if (digits.length === 10) {
    return digits.replace(/^(\d{2})(\d{4})(\d{4})$/, '($1) $2-$3');
  }
  return raw;
}

/**
 * Mask all but the last `showLast` characters of `value` with `*` — the port of
 * the Flutter `obscurecerString`. Used by the orçamento to hide the customer's
 * full CPF/CNPJ/IE while keeping the trailing digits for recognition. Values
 * with `length <= showLast` are returned unchanged.
 */
export function obscure(value: string, showLast = 3): string {
  if (value.length <= showLast) return value;
  return '*'.repeat(value.length - showLast) + value.slice(-showLast);
}

/** A datetime field stored as microseconds since epoch → a JS `Date`. */
export function microsToDate(micros: number): Date {
  return new Date(Math.round(micros / 1000));
}

/** `dd/MM/yyyy` for a µs-since-epoch instant (pt-BR). */
export function formatDate(micros: number): string {
  return microsToDate(micros).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/** `dd/MM/yyyy HH:mm` for a µs-since-epoch instant (pt-BR). */
export function formatDateTime(micros: number): string {
  return microsToDate(micros).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Number formatted with the pt-BR decimal pattern (e.g. `1.234,5`). */
export function formatQuantidade(value: number): string {
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}
