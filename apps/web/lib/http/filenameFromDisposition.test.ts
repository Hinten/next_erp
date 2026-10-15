import { describe, expect, it } from 'vitest';

import { filenameFromDisposition } from './filenameFromDisposition';

/**
 * The helper both label clients (Mercado Livre, Shopee) read the server's
 * filename through. `null` is the caller's cue to use its own fallback name, so
 * every case below is either "this is the name" or "use yours" — and a wrong
 * `null` is as visible to the operator as a wrong name (the file saves as
 * `etiqueta-<pedidoId>` instead of the pedido number).
 */
describe('filenameFromDisposition', () => {
  it('reads the quoted name the label routes send', () => {
    // The exact header shape `apps/shopee`'s label route answers.
    expect(
      filenameFromDisposition('attachment; filename="etiqueta-shopee-260910KJBHUJDM-p1de2.pdf"'),
    ).toBe('etiqueta-shopee-260910KJBHUJDM-p1de2.pdf');
  });

  it('reads an unquoted name', () => {
    expect(filenameFromDisposition('attachment; filename=etiqueta-123.zip')).toBe(
      'etiqueta-123.zip',
    );
  });

  it("reads the RFC 5987 `filename*=UTF-8''` form and percent-decodes it", () => {
    expect(filenameFromDisposition("attachment; filename*=UTF-8''etiqueta%20n%C2%BA%201.pdf")).toBe(
      'etiqueta nº 1.pdf',
    );
  });

  it('matches the parameter name case-insensitively', () => {
    expect(filenameFromDisposition('attachment; FILENAME="x.pdf"')).toBe('x.pdf');
  });

  it('⚠️ keeps a stray `%` UNDECODED instead of failing a byte-successful fetch', () => {
    // `decodeURIComponent('100%.pdf')` throws a URIError. The label already
    // arrived; losing it over its NAME would be the wrong trade.
    expect(filenameFromDisposition('attachment; filename="100%.pdf"')).toBe('100%.pdf');
  });

  it('a decodable escape IS decoded — the near miss of the case above', () => {
    // Without this, "never decode" would pass the stray-`%` case just as well.
    expect(filenameFromDisposition('attachment; filename="100%25.pdf"')).toBe('100%.pdf');
  });

  it('stops at the next parameter', () => {
    expect(filenameFromDisposition('attachment; filename=a.pdf; size=10')).toBe('a.pdf');
  });

  it('an absent or empty header ⇒ null (the caller falls back)', () => {
    // `null` is what the browser hands back when the proxy does not expose the
    // header — a backend deployed before `Access-Control-Expose-Headers`.
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition('')).toBeNull();
  });

  it('a header without a filename, or with an EMPTY one ⇒ null, never an empty name', () => {
    expect(filenameFromDisposition('attachment')).toBeNull();
    expect(filenameFromDisposition('inline')).toBeNull();
    expect(filenameFromDisposition('attachment; filename=""')).toBeNull();
  });
});
