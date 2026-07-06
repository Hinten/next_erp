/**
 * Pure formatting helpers for the DANFE renderers — ported from the legacy
 * Flutter `danfe_nfe/src/utils.dart` (+ the `global` package's cpf/cnpj/cep/
 * phone formatters the old layout pulled in). No I/O, no PDF/ZPL coupling, so
 * the same helpers feed the pdfkit, ZPL and (future) retrato/paisagem outputs
 * and are cheap to unit-test.
 *
 * All money/quantity formatting is pt-BR (`1.234,56`); dates are rendered in
 * `America/Sao_Paulo` (the issuer's local time SEFAZ stamps), pinned via a
 * fixed `timeZone` so output is deterministic regardless of host TZ.
 */

/** Points per centimetre (PDF user space is 72 dpi → 72/2.54). */
export const PT_PER_CM = 72 / 2.54; // 28.3464566929…

/** Convert a centimetre measure to PDF points. Mirrors `cmToPixel` in utils.dart. */
export function cmToPt(cm: number): number {
  return cm * PT_PER_CM;
}

/** Strip everything that isn't a digit. */
export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Truncate to `length` chars (the old `cutString`). */
export function cutString(value: string, length: number): string {
  return value.length > length ? value.slice(0, length) : value;
}

/**
 * Group the 44-digit chave de acesso into eleven blocks of four
 * (`AAAA BBBB … KKKK`) for human reading. Mirrors `formataChaveDeAcesso`.
 */
export function formatChaveAcesso(value: string): string {
  const chave = onlyDigits(value);
  const groups: string[] = [];
  for (let i = 0; i < chave.length; i += 4) {
    groups.push(chave.slice(i, i + 4));
  }
  return groups.join(' ');
}

/**
 * Format a CPF (11 digits) or CNPJ (14 digits). Falls back to the raw input
 * when the digit count matches neither (the layout never hides the value).
 */
export function formatCpfCnpj(value: string): string {
  const d = onlyDigits(value);
  if (d.length === 11) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  return value;
}

/** Format a CEP (`00000-000`); falls back to the raw input when not 8 digits. */
export function formatCep(value: string): string {
  const d = onlyDigits(value);
  if (d.length === 8) return `${d.slice(0, 5)}-${d.slice(5)}`;
  return value;
}

/** Format a Brazilian phone (`(00) 0000-0000` / `(00) 00000-0000`). */
export function formatTelefone(value: string): string {
  const d = onlyDigits(value);
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  return value;
}

/**
 * Pad the número to 9 digits and group it `000.000.000`. Mirrors `formatarNNF`.
 */
export function formatNNF(nNF: string): string {
  const padded = onlyDigits(nNF).padStart(9, '0');
  return `${padded.slice(0, 3)}.${padded.slice(3, 6)}.${padded.slice(6, 9)}`;
}

/** Left-pad the série to 3 digits (`001`). */
export function formatSerie(serie: string): string {
  return onlyDigits(serie).padStart(3, '0');
}

const moneyFmt = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const qtyFmt = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

/**
 * Format a monetary string/number pt-BR with two decimals and **no** currency
 * symbol (`1.234,50`). Mirrors `parseMoney` + the `f` NumberFormat. An empty
 * input returns `''`; a non-numeric input is returned verbatim.
 */
export function formatMoney(value: string | number): string {
  if (value === '' || value == null) return '';
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) return String(value);
  return moneyFmt.format(n);
}

/** Format a quantity pt-BR with up to four decimals, trimming trailing zeros. */
export function formatQty(value: string | number): string {
  if (value === '' || value == null) return '';
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) return String(value);
  return qtyFmt.format(n);
}

export class NFeDanfeFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeDanfeFormatError';
  }
}

/**
 * SEFAZ date/date-time lexical: `AAAA-MM-DD` (TData — e.g. `dVenc`) or
 * `AAAA-MM-DDThh:mm:ss±hh:mm` (TDateTimeUTC — the XSD REQUIRES the offset,
 * never `Z` / offset-less). Groups: 1=year 2=month 3=day 4=hour 5=min 6=sec.
 */
const SEFAZ_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/;

/**
 * DANFE date/time rendering — the wall-clock AS STAMPED in the SEFAZ lexical
 * (#418). The string already embeds the right clock: the ISSUER's offset on
 * dhEmi / dhSaiEnt / dhCont / dhEvento (per-UF, see `generator/tz.ts`), the
 * AUTHORIZER's on dhRecbto / dhRegEvento. Re-rendering the instant through a
 * pinned zone distorted every non−03:00 filial's document, and — because JS
 * parses date-only ISO as UTC midnight — printed the duplicata `dVenc` one day
 * EARLY even for São Paulo. So: slice the lexical, never parse to a Date.
 */
function sefazDateParts(value: string): RegExpExecArray {
  const m = SEFAZ_DATE_RE.exec(value);
  if (!m) {
    throw new NFeDanfeFormatError(
      `not a SEFAZ date/date-time lexical (AAAA-MM-DD[Thh:mm:ss±hh:mm]): '${value}'`,
    );
  }
  return m;
}

/** `dd/MM/yyyy`, exactly as stamped on the wire (date-only or date-time input). */
export function formatDate(iso: string): string {
  const [, yyyy, mm, dd] = sefazDateParts(iso);
  return `${dd}/${mm}/${yyyy}`;
}

/** `HH:mm`, exactly as stamped on the wire. Requires a date-TIME input. */
export function formatTime(iso: string): string {
  const [, , , , hh, min] = sefazDateParts(iso);
  if (hh === undefined) {
    throw new NFeDanfeFormatError(`no time part in '${iso}' (expected AAAA-MM-DDThh:mm:ss±hh:mm)`);
  }
  return `${hh}:${min}`;
}

/** `HH:mm:ss`, exactly as stamped on the wire. Requires a date-TIME input. */
export function formatTimeSeconds(iso: string): string {
  const [, , , , hh, min, ss] = sefazDateParts(iso);
  if (hh === undefined) {
    throw new NFeDanfeFormatError(`no time part in '${iso}' (expected AAAA-MM-DDThh:mm:ss±hh:mm)`);
  }
  return `${hh}:${min}:${ss}`;
}

/**
 * Modalidade do frete label (`modFrete`) shown in the transportador box.
 * Mirrors the `freteContent` switch in `base.dart`.
 */
export function freteLabel(modFrete: string): string {
  switch (modFrete) {
    case '0':
      return '0 - REM. (CIF)';
    case '1':
      return '1 - DEST. (FOB)';
    case '2':
      return '2 - TERC.';
    case '3':
      return '3 - PROP./REM.';
    case '4':
      return '4 - PROP./DEST.';
    case '9':
      return '9 - SEM FRETE';
    default:
      return '';
  }
}
