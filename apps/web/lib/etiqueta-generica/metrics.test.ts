import { describe, expect, it } from 'vitest';

import { measurableCharacters, textWidthMm } from './metrics';

/**
 * The width tables are hand-carried Adobe AFM numbers, and a single mistyped
 * entry would silently let a line run past the trim. Cross-check them against
 * jsPDF's own metrics — the renderer the PDF actually uses.
 *
 * ⚠️ The property asserted is **"never under-measure"**, not "match exactly".
 * jsPDF quantises its widths slightly differently, so per-character values
 * disagree by ~0.007mm either way as pure rounding noise; that is meaningless.
 * Under-measuring is the only direction that hurts — it is what lets a wrapped
 * line still overflow the box. Over-measuring merely wraps a word early, which
 * the layout module explicitly prefers.
 */
const ROUNDING_NOISE_MM = 0.03;

async function jsPdfWidth(text: string, sizePt: number, bold: boolean): Promise<number> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: [100, 150] });
  doc.setFont('helvetica', bold ? 'bold' : 'normal');
  doc.setFontSize(sizePt);
  return doc.getTextWidth(text);
}

describe('textWidthMm', () => {
  for (const bold of [false, true]) {
    it(`never under-measures a character vs jsPDF (${bold ? 'bold' : 'normal'})`, async () => {
      const under: string[] = [];
      for (const ch of measurableCharacters()) {
        const mine = textWidthMm(ch, 10, bold);
        const theirs = await jsPdfWidth(ch, 10, bold);
        if (mine < theirs - ROUNDING_NOISE_MM) {
          under.push(`${JSON.stringify(ch)} mine=${mine.toFixed(4)} jspdf=${theirs.toFixed(4)}`);
        }
      }
      expect(under).toEqual([]);
    });
  }

  it('measures the real lines the label draws, without under-measuring any of them', async () => {
    const lines: Array<[string, number, boolean]> = [
      ['Pedido 12345', 12, true],
      ['Motoboy Centro (Motoboy)', 10, true],
      ['NFe nº: 4821', 10, true],
      ['Cliente: MARIA DAS GRAÇAS XAVIER DE OLIVEIRA SOUZA', 10, false],
      ['Logradouro: AVENIDA PRESIDENTE JUSCELINO KUBITSCHEK', 10, false],
      ['Volumes: 3 volume(s) · 12,45 kg', 10, true],
      ['Cidade: São Paulo - SP', 10, false],
      ['Recebido: _________________________________', 10, true],
    ];
    for (const [text, size, bold] of lines) {
      const mine = textWidthMm(text, size, bold);
      const theirs = await jsPdfWidth(text, size, bold);
      expect(mine).toBeGreaterThanOrEqual(theirs - ROUNDING_NOISE_MM);
      // …and not wildly over, or the label would wrap far too eagerly.
      expect(mine).toBeLessThan(theirs + 1);
    }
  });

  it('is the measurement the wrap actually needed — uppercase is ~40% wider than the old 0.5em guess', () => {
    // The first cut assumed a flat 0.5em advance, which yielded 51 characters
    // for the 90mm inner width at 10pt. These are what those 51 really measure.
    expect(textWidthMm('X'.repeat(51), 10, false)).toBeGreaterThan(110);
    expect(textWidthMm('1'.repeat(51), 10, false)).toBeGreaterThan(95);
  });

  it('scales linearly with the point size', () => {
    expect(textWidthMm('AAAA', 20, false)).toBeCloseTo(2 * textWidthMm('AAAA', 10, false), 6);
  });

  it('never under-measures an unknown glyph', () => {
    // A glyph outside the table (e.g. a CJK name pasted into a cadastro) gets
    // the widest advance in the font, so it wraps early rather than overflowing.
    expect(textWidthMm('漢', 10, false)).toBeGreaterThanOrEqual(textWidthMm('W', 10, false));
  });
});
