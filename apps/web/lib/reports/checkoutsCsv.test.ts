import { describe, expect, it } from 'vitest';
import { checkoutsCsv } from './checkoutsCsv';

describe('checkout CSV', () => {
  it('treats a numeric-looking user name as text', () => {
    expect(
      checkoutsCsv(
        { total: 3, rows: [{ userId: 'a', label: '-10', count: 3 }] },
        '2026-09-01',
        '2026-09-11',
      ),
    ).toContain("\r\n'-10;3\r\n");
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
