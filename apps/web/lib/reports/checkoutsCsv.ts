import type { CheckoutReport } from './aggregations';

/** Report CSV convention: semicolons, CRLF and a UTF-8 BOM for spreadsheet apps. */
export function checkoutCsvCell(value: string | number): string {
  let text = String(value);
  // User-provided labels are always text, even if they look like numbers/formulas.
  if (
    typeof value === 'string' &&
    (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text))
  ) {
    text = `'${text}`;
  }
  return /[;"\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function checkoutsCsv(report: CheckoutReport, start: string, end: string): string {
  const rows: (string | number)[][] = [
    ['Data início', start],
    ['Data fim', end],
    ['Usuário', 'Checkouts'],
    ...report.rows.map((row) => [row.label, row.count]),
    ['Total de checkouts', report.total],
  ];
  return '\uFEFF' + rows.map((row) => row.map(checkoutCsvCell).join(';')).join('\r\n') + '\r\n';
}

export function downloadCheckoutsCsv(report: CheckoutReport, start: string, end: string): void {
  const url = URL.createObjectURL(
    new Blob([checkoutsCsv(report, start, end)], { type: 'text/csv;charset=utf-8;' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `checkouts-${start}-${end}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
