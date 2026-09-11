import { describe, expect, it } from 'vitest';
import { checkoutCsvCell, checkoutsCsv } from './checkoutsCsv';

describe('checkout CSV', () => {
  it.each([
    '=SUM(A1)',
    '+cmd',
    '-cmd',
    '@cmd',
    '\t=cmd',
    '\r=cmd',
    '\n=cmd',
    '  =cmd',
    '\u0000=cmd',
    '-10',
  ])('neutralizes spreadsheet formula label %j', (label) => {
    expect(checkoutCsvCell(label)).toContain(`'${label}`);
  });
  it('preserves ordinary labels and counts and escapes semicolons, quotes and multiline cells', () => {
    expect(checkoutCsvCell('Ana')).toBe('Ana');
    expect(checkoutCsvCell('001')).toBe('001');
    expect(checkoutCsvCell(10)).toBe('10');
    expect(checkoutCsvCell('Ana; "B"\nSilva')).toBe('"Ana; ""B""\nSilva"');
  });
  it('exports the displayed buckets, dates and total using BOM, semicolon and CRLF', () => {
    expect(
      checkoutsCsv(
        {
          total: 5,
          rows: [
            { userId: 'a', label: '=Ana', count: 2 },
            { userId: null, label: 'Outros usuários', count: 3 },
          ],
        },
        '2026-09-01',
        '2026-09-11',
      ),
    ).toBe(
      "\uFEFFData início;2026-09-01\r\nData fim;2026-09-11\r\nUsuário;Checkouts\r\n'=Ana;2\r\nOutros usuários;3\r\nTotal de checkouts;5\r\n",
    );
  });
});
