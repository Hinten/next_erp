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
/**
 * Format a CPF or a CNPJ. Re-exported from `@delfrance/core/documents` rather
 * than reimplemented here — same as `formatTelefone` below.
 *
 * ⚠️ This file's copy was the CORRECT one of three: it masked the CNPJ
 * positionally, so the alphanumeric CNPJ (RFB IN 2.229/2024) came out right,
 * while the DANFE renderers' copy and `PedidoCells`' copy both stripped
 * non-digits first and rendered `12ABC678000190` as an eleven-digit **CPF**.
 * Being right was not enough: nothing could tell the three apart, and a
 * reviewer cannot diff them by eye. The shared version is the same rule with
 * one place to read it.
 */
export { formatCpfCnpj } from '@delfrance/core/documents';

/** Format an 8-digit CEP as `00000-000`; anything else is returned unchanged. */
export function formatCep(raw: string): string {
  const digits = onlyDigits(raw);
  if (digits.length === 8) {
    return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  }
  return raw;
}

/**
 * Format a stored telefone. Re-exported from `@delfrance/core/phone` rather
 * than reimplemented here — same as `formatReais` above — so every print
 * surface masks the SAME way.
 *
 * It used to be a local copy that masked only 10/11-digit input and returned
 * anything else raw. Once clientes started being stored as 13-digit
 * `5511999998888`, every sheet importing this printed the raw string; the
 * `55`-stripping fix existed but was inlined in one unrelated page. The shared
 * version strips before masking, so the omission is no longer possible.
 */
export { formatTelefone } from '@delfrance/core/phone';

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
