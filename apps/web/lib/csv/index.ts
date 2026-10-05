/** UTF-8 BOM keeps accented labels readable in spreadsheet applications. */
export const CSV_BOM = '\uFEFF';

export type CsvCell = string | number | null | undefined;

export interface CsvOptions {
  /** Accept preformatted decimal strings (e.g. NF-e money: "-5,50") as numbers. */
  numericStrings?: boolean;
}

const NUMERIC = /^-?[\d.,]+$/;
const FORMULA_LEAD = /^[\s\u0000-\u001f]*[=+@-]/u;
const CONTROL_LEAD = /^[\t\r\n]/u;

/** Strings are text by default; callers with formatted money explicitly opt in. */
export function csvCell(value: CsvCell, { numericStrings = false }: CsvOptions = {}): string {
  let text = value == null ? '' : String(value);
  if (
    typeof value === 'string' &&
    (FORMULA_LEAD.test(text) || CONTROL_LEAD.test(text)) &&
    !(numericStrings && NUMERIC.test(text))
  ) {
    text = `'${text}`;
  }
  return /[;"\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRow(cells: readonly CsvCell[], options?: CsvOptions): string {
  return cells.map((cell) => csvCell(cell, options)).join(';');
}
