/**
 * A 17-digit `nProt` (NT 2025.002 §5.1, #329) on every document that prints
 * one: DANFE retrato / paisagem / simplificado, their EPEC variants, the CC-e
 * PDF and the ZPL label.
 *
 * ⚠️ The check is "the text fits its box", measured — not "the PDF renders".
 * A value wider than its box does not throw: pdfkit wraps it onto a second line
 * that spills out of the field (the ellipsis only fires when a height is set),
 * so a render-succeeds test would pass on a broken layout. Each `doc.text` call
 * is intercepted and its string measured against the width it was given, and a
 * control case proves the measurement can fail.
 */
import PDFDocument from 'pdfkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderDanfe, renderDanfeZpl } from '../../src/danfe';
import { parseProcNFe, type DanfeModel } from '../../src/danfe/model';
import { renderCce } from '../../src/danfe/pdf/cce';
import { renderPaisagem } from '../../src/danfe/pdf/paisagem';
import { renderRetrato } from '../../src/danfe/pdf/retrato';
import { PROCNFE_FIXTURE } from './fixtures';

const NPROT_15 = '135260000000456';
const NPROT_17 = '13526000000045678';
const PROCNFE_NPROT17 = PROCNFE_FIXTURE.replace(
  `<nProt>${NPROT_15}</nProt>`,
  `<nProt>${NPROT_17}</nProt>`,
);

interface Chamada {
  readonly str: string;
  readonly width: number | undefined;
  readonly medido: number;
}

let chamadas: Chamada[] = [];

beforeEach(() => {
  chamadas = [];
  const original = PDFDocument.prototype.text;
  vi.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (
    this: PDFKit.PDFDocument,
    ...args: unknown[]
  ) {
    const str = String(args[0]);
    const opts = args.find((a, i) => i > 0 && a != null && typeof a === 'object') as
      | { width?: number }
      | undefined;
    chamadas.push({ str, width: opts?.width, medido: this.widthOfString(str) });
    return (original as (...a: unknown[]) => PDFKit.PDFDocument).apply(this, args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every drawn string containing `nProt` fits the width it was drawn in. */
function expectCabe(nProt: string): void {
  const hits = chamadas.filter((c) => c.str.includes(nProt));
  expect(hits.length, `no text call carried ${nProt}`).toBeGreaterThan(0);
  for (const h of hits) {
    expect(h.width, `'${h.str}' drawn with no width`).toBeDefined();
    expect(h.medido, `'${h.str}' is ${h.medido}pt in a ${h.width}pt box`).toBeLessThanOrEqual(
      h.width!,
    );
  }
}

function modelEpec(nProt: string): DanfeModel {
  return {
    ...parseProcNFe(PROCNFE_FIXTURE),
    prot: null,
    epec: { nProt, dhRegEvento: '2026-06-10T10:00:00-03:00' },
  };
}

describe('a 17-digit nProt fits every document that prints it', () => {
  it('the fixture really carries the 17-digit protocol', () => {
    expect(PROCNFE_NPROT17).toContain(`<nProt>${NPROT_17}</nProt>`);
    expect(parseProcNFe(PROCNFE_NPROT17).prot?.nProt).toBe(NPROT_17);
  });

  it.each(['retrato', 'paisagem', 'simplificado'] as const)('DANFE %s', async (format) => {
    await renderDanfe(PROCNFE_NPROT17, { format });
    expectCabe(NPROT_17);
  });

  it('DANFE retrato — EPEC protocol box', async () => {
    await renderRetrato(modelEpec(NPROT_17));
    expectCabe(NPROT_17);
  });

  it('DANFE paisagem — EPEC protocol box', async () => {
    await renderPaisagem(modelEpec(NPROT_17));
    expectCabe(NPROT_17);
  });

  it('CC-e PDF', async () => {
    await renderCce(parseProcNFe(PROCNFE_FIXTURE), {
      xCorrecao: 'Correcao do endereco de entrega: leia-se RUA NOVA, 100.',
      nProt: NPROT_17,
      nSeqEvento: 2,
      dhRegEvento: '2026-06-10T10:00:00-03:00',
    });
    expectCabe(NPROT_17);
  });

  it('ZPL label prints the whole protocol', () => {
    expect(renderDanfeZpl(PROCNFE_NPROT17)).toContain(`^FD${NPROT_17} `);
  });

  it('control — a protocol that cannot fit IS caught by the measurement', async () => {
    const LONGO = '1'.repeat(60);
    await renderRetrato(modelEpec(LONGO));
    const hits = chamadas.filter((c) => c.str.includes(LONGO));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.width != null && h.medido > h.width)).toBe(true);
  });
});
