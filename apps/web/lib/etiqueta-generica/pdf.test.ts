import { describe, expect, it } from 'vitest';

import { encodeCode128C } from './barcode';
import { CHAVE, COM_NFE_MODEL, MINIMAL_MODEL } from './fixtures';
import { renderEtiquetaGenericaPdf } from './pdf';

/**
 * These assert the REAL jsPDF output, not a mock. jsPDF leaves the content
 * stream uncompressed, so the drawing operators are readable text — which is
 * what makes "the label is vector" a checkable claim rather than a promise.
 */
async function pdfSource(model: Parameters<typeof renderEtiquetaGenericaPdf>[0]): Promise<string> {
  const blob = await renderEtiquetaGenericaPdf(model);
  return Buffer.from(await blob.arrayBuffer()).toString('latin1');
}

describe('renderEtiquetaGenericaPdf', () => {
  it('produces a single-page 10x15cm PDF blob', async () => {
    const blob = await renderEtiquetaGenericaPdf(MINIMAL_MODEL);
    expect(blob.type).toBe('application/pdf');

    const src = Buffer.from(await blob.arrayBuffer()).toString('latin1');
    expect(src.startsWith('%PDF')).toBe(true);
    expect(src.match(/\/Type \/Page[^s]/g) ?? []).toHaveLength(1);

    // 100mm x 150mm expressed in points (72/25.4 per mm).
    const mediaBox = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(src);
    expect(Number(mediaBox?.[1])).toBeCloseTo((100 * 72) / 25.4, 3);
    expect(Number(mediaBox?.[2])).toBeCloseTo((150 * 72) / 25.4, 3);
  });

  it('draws real text, not a rasterised image', async () => {
    const src = await pdfSource(MINIMAL_MODEL);
    // Text-showing operators with the label's actual strings — the previous
    // renderer captured the whole label to a JPEG, so none of this existed.
    expect(src).toContain('(Pedido 12345) Tj');
    expect(src).toContain('(Cliente: Maria Aparecida de Souza) Tj');
    expect(src).not.toContain('/Subtype /Image');
    expect(src).not.toContain('DCTDecode'); // the JPEG filter
  });

  it('switches between Helvetica and Helvetica-Bold at the legacy sizes', async () => {
    const src = await pdfSource(MINIMAL_MODEL);
    const fonts = new Set(src.match(/\/F\d+ [\d.]+ Tf/g) ?? []);
    // /F1 = Helvetica, /F2 = Helvetica-Bold in jsPDF's standard-14 table.
    expect(fonts).toContain('/F2 12 Tf'); // title + address-block titles
    expect(fonts).toContain('/F1 10 Tf'); // body
  });

  it('draws the Code 128 as vector bars — one filled rect per bar', async () => {
    const bars = encodeCode128C(CHAVE)!.bars.length;
    const withNfe = (await pdfSource(COM_NFE_MODEL)).match(/ re\b/g) ?? [];
    const withoutNfe = (await pdfSource(MINIMAL_MODEL)).match(/ re\b/g) ?? [];

    // Without an NF-e: the outer border only — legacy printed no barcode at all.
    expect(withoutNfe).toHaveLength(1);
    // With one: the border plus every bar of the symbol.
    expect(withNfe).toHaveLength(1 + bars);
  });
});
