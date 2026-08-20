import { describe, expect, it } from 'vitest';

import { CHAVE, COM_NFE_MODEL, LONG_STRINGS_MODEL, MAXIMAL_MODEL, MINIMAL_MODEL } from './fixtures';
import { buildEtiquetaGenericaLayout, LABEL_H_MM, type EtiquetaOp } from './layout';
import { renderEtiquetaGenericaZpl } from './zpl2';

describe('renderEtiquetaGenericaZpl', () => {
  it('emits a well-formed ZPL label', () => {
    const zpl = renderEtiquetaGenericaZpl(MINIMAL_MODEL);
    expect(zpl.startsWith('^XA')).toBe(true);
    expect(zpl.endsWith('^XZ')).toBe(true);
    expect(zpl).toContain('^CI28'); // UTF-8 — Portuguese accents survive
    expect(zpl).toContain('^LH0,0');
  });

  it('scales the label with the printhead density', () => {
    // 100mm and 150mm in dots: 203dpi = 8 dots/mm, 300dpi = 11.81.
    expect(renderEtiquetaGenericaZpl(MINIMAL_MODEL)).toContain('^PW799');
    expect(renderEtiquetaGenericaZpl(MINIMAL_MODEL)).toContain('^LL1199');
    const at300 = renderEtiquetaGenericaZpl(MINIMAL_MODEL, { dpi: 300 });
    expect(at300).toContain('^PW1181');
    expect(at300).toContain('^LL1772');
  });

  it('draws the same strings the PDF draws — one label, two renderers', () => {
    // This is the whole point of the shared layout spec: the ZPL is not a second
    // interpretation of the design, it is the same op list expressed in ZPL.
    const zpl = renderEtiquetaGenericaZpl(MAXIMAL_MODEL);
    const drawn = buildEtiquetaGenericaLayout(MAXIMAL_MODEL)
      .ops.filter((op): op is Extract<EtiquetaOp, { kind: 'text' }> => op.kind === 'text')
      .map((op) => op.text);
    expect(drawn.length).toBeGreaterThan(10);
    for (const text of drawn) expect(zpl).toContain(`^FD${text}^FS`);
  });

  it('keeps accents intact rather than mangling them', () => {
    const zpl = renderEtiquetaGenericaZpl(MINIMAL_MODEL);
    expect(zpl).toContain('Cidade: São Paulo - SP');
    // …and the bytes really are UTF-8, which is what `^CI28` declares. The
    // legacy estoque ZPL encoder base64'd UTF-16 code units and mojibaked every
    // accent (#457); this path is byte-correct by construction and stays that
    // way because of this assertion.
    const bytes = new TextEncoder().encode(zpl);
    expect(bytes).toContain(0xc3); // the lead byte of ã / ç / é in UTF-8
    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(zpl);
  });

  it('sends a Blob of exactly those UTF-8 bytes to the print agent', async () => {
    // The provider wraps the string in a Blob and `printJob` base64s the BYTES,
    // so this pins the whole encoding chain the legacy encoder got wrong.
    const zpl = renderEtiquetaGenericaZpl(MINIMAL_MODEL);
    const blob = new Blob([zpl], { type: 'text/plain;charset=utf-8' });
    const roundTripped = Buffer.from(await blob.arrayBuffer()).toString('utf8');
    expect(roundTripped).toBe(zpl);
    expect(roundTripped).toContain('São Paulo');
  });

  it('encodes the NF-e chave as a native subset-C Code 128', () => {
    const zpl = renderEtiquetaGenericaZpl(COM_NFE_MODEL);
    expect(zpl).toContain('^BCN,');
    // `>;` switches Code 128 to subset C: two digits per symbol, half the width.
    expect(zpl).toContain(`^FD>;${CHAVE}^FS`);
    expect(zpl).toMatch(/\^BY[2-9]\^BCN/);
  });

  it('draws no barcode when the pedido has no authorized NF-e', () => {
    const zpl = renderEtiquetaGenericaZpl(MINIMAL_MODEL);
    expect(zpl).not.toContain('^BCN');
    expect(zpl).not.toContain('^BY');
  });

  it('strips the ZPL control prefixes from field data without uppercasing it', () => {
    // A razão social carrying a `^` or `~` would otherwise terminate the field
    // or inject a command.
    const hostile = {
      ...MINIMAL_MODEL,
      cliente: { nome: 'ACME ^ TILDE ~ Ltda', telefone: null, cpfCnpj: null },
    };
    const zpl = renderEtiquetaGenericaZpl(hostile);
    expect(zpl).toContain('Cliente: ACME   TILDE   Ltda');
    // The DANFE renderer uppercases; this one must not — the PDF prints values
    // verbatim and the two formats have to read the same.
    expect(zpl).not.toContain('CLIENTE: ACME');
  });

  it('boxes the label and every divider with ^GB', () => {
    const zpl = renderEtiquetaGenericaZpl(MAXIMAL_MODEL);
    // The outer border plus the five dividers (header, cliente, endereço,
    // recebedor, volumes).
    expect(zpl.match(/\^GB/g) ?? []).toHaveLength(6);
  });

  it.each([
    ['maximal', MAXIMAL_MODEL],
    // The shrink-to-fit case: the layout hands the walker scaled `y` and
    // fractional `sizePt`, so this also pins that the ZPL side survives it.
    ['long uppercase strings', LONG_STRINGS_MODEL],
  ])('keeps every field origin inside the label (%s)', (_name, model) => {
    const zpl = renderEtiquetaGenericaZpl(model);
    const maxDots = Math.round((LABEL_H_MM * 203) / 25.4);
    const ys = [...zpl.matchAll(/\^FO\d+,(\d+)/g)].map((m) => Number(m[1]));
    expect(ys.length).toBeGreaterThan(10);
    for (const y of ys) expect(y).toBeLessThanOrEqual(maxDots);
  });

  it('emits an integer dot for every coordinate, even on a shrunk label', () => {
    // `^FO`/`^A0N`/`^GB` take whole dots; a fractional value from the squeeze
    // would be silently truncated by the printer, or reject the field outright.
    const zpl = renderEtiquetaGenericaZpl(LONG_STRINGS_MODEL);
    expect(zpl).not.toMatch(/\^(FO|GB|A0N|BY)[^^\n]*\d\.\d/);
  });
});
