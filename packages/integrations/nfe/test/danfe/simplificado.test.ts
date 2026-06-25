import { describe, expect, it } from 'vitest';

import { renderDanfe, renderDanfeZpl } from '../../src/danfe';
import { cmToPt } from '../../src/danfe/format';
import { parseProcNFe } from '../../src/danfe/model';
import type { DanfeEndereco } from '../../src/danfe/model';
import { clipToWidth, createPdf, FONT } from '../../src/danfe/pdf/primitives';
import {
  enderecoLinha,
  planSimplificadoFit,
  renderSimplificado,
} from '../../src/danfe/pdf/simplificado';
import { PROCNFE_FIXTURE, PROCNFE_MAXFIELDS_FIXTURE, PROCNFE_MINFIELDS_FIXTURE } from './fixtures';
import { isPdf, pageCount } from './helpers';

describe('danfe/pdf simplificado', () => {
  it('renders a non-trivial PDF buffer', async () => {
    const pdf = await renderSimplificado(parseProcNFe(PROCNFE_FIXTURE));
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('renders the cancelada overlay variant without throwing', async () => {
    const pdf = await renderSimplificado(parseProcNFe(PROCNFE_FIXTURE), { cancelada: true });
    expect(isPdf(pdf)).toBe(true);
  });

  it('renders via the public renderDanfe entry (format=simplificado)', async () => {
    const pdf = await renderDanfe(PROCNFE_FIXTURE, { format: 'simplificado' });
    expect(isPdf(pdf)).toBe(true);
  });

  it('renders via the public renderDanfe entry (format=paisagem)', async () => {
    const pdf = await renderDanfe(PROCNFE_FIXTURE, { format: 'paisagem' });
    expect(isPdf(pdf)).toBe(true);
  });

  it('renderDanfeZpl returns a ZPL string', () => {
    expect(renderDanfeZpl(PROCNFE_FIXTURE)).toContain('^XA');
  });
});

// ---------------------------------------------------------------------------
// Text fitting / overflow (#93). The label is a fixed 10×15 cm and never
// paginates, so the regression guard is a pure geometry invariant — the fitted
// content must stay above the frame bottom. `pageCount` can NOT catch this: an
// absolute-positioned, height-bounded overflow draws off the page edge while
// pageCount stays 1.
// ---------------------------------------------------------------------------
describe('danfe/pdf simplificado — fits on one page', () => {
  const FRAME_BOTTOM = cmToPt(15) - cmToPt(0.35);

  it.each([
    ['base', PROCNFE_FIXTURE],
    ['max-fields (B2B dest with IE + long values)', PROCNFE_MAXFIELDS_FIXTURE],
    ['min-fields', PROCNFE_MINFIELDS_FIXTURE],
  ] as const)('%s content stays inside the frame', (_name, fx) => {
    const plan = planSimplificadoFit(parseProcNFe(fx));
    expect(plan.fits).toBe(true);
    expect(plan.contentBottomPt).toBeLessThanOrEqual(FRAME_BOTTOM);
  });

  it.each([
    ['max-fields', PROCNFE_MAXFIELDS_FIXTURE],
    ['min-fields', PROCNFE_MINFIELDS_FIXTURE],
  ] as const)('renders a one-page PDF for the %s fixture', async (_name, fx) => {
    const pdf = await renderSimplificado(parseProcNFe(fx));
    expect(isPdf(pdf)).toBe(true);
    expect(pageCount(pdf)).toBe(1);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('renders the cancelada overlay on the max-fields fixture', async () => {
    const pdf = await renderSimplificado(parseProcNFe(PROCNFE_MAXFIELDS_FIXTURE), {
      cancelada: true,
    });
    expect(isPdf(pdf)).toBe(true);
    expect(pageCount(pdf)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// clipToWidth — the name/value ellipsis cuts on a word boundary when one is
// close, and falls back to a hard cut for a single long token (#93).
// ---------------------------------------------------------------------------
describe('clipToWidth — word-boundary ellipsis', () => {
  it('backs up to a word boundary instead of cutting mid-word', () => {
    const { doc } = createPdf([200, 200]);
    doc.font(FONT).fontSize(7);
    const str = 'PRIMEIRO SEGUNDO TERCEIRO QUARTO QUINTO';
    const maxWidth = doc.widthOfString('PRIMEIRO SEGUNDO TERC'); // lands mid-"TERCEIRO"
    const clipped = clipToWidth(doc, str, maxWidth, FONT, 7);
    const body = clipped.slice(0, -1);
    expect(clipped.endsWith('…')).toBe(true);
    expect(str.startsWith(body)).toBe(true);
    // Cut exactly at a space: the original char after the kept text is the
    // removed separator, never a letter (i.e. not mid-word).
    expect(str.charAt(body.length)).toBe(' ');
  });

  it('falls back to a hard cut for a single long token (no space)', () => {
    const { doc } = createPdf([200, 200]);
    doc.font(FONT).fontSize(7);
    const token = 'A'.repeat(60);
    const maxWidth = doc.widthOfString('A'.repeat(20));
    const clipped = clipToWidth(doc, token, maxWidth, FONT, 7);
    const body = clipped.slice(0, -1);
    expect(clipped.endsWith('…')).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThan(token.length);
    expect(token.startsWith(body)).toBe(true);
  });

  it('returns the string unchanged when it already fits', () => {
    const { doc } = createPdf([200, 200]);
    doc.font(FONT).fontSize(7);
    expect(clipToWidth(doc, 'SHORT', 500, FONT, 7)).toBe('SHORT');
  });
});

// ---------------------------------------------------------------------------
// enderecoLinha — no stray separators for missing fields, byte-identical for a
// fully-populated address (#93).
// ---------------------------------------------------------------------------
describe('enderecoLinha — separator hygiene', () => {
  const base: DanfeEndereco = {
    logradouro: 'RUA DAS FLORES',
    numero: '1000',
    complemento: 'SALA 2',
    bairro: 'CENTRO',
    municipio: 'SAO PAULO',
    uf: 'SP',
    cep: '01001000',
    fone: null,
  };

  it('renders a fully-populated address exactly as before', () => {
    expect(enderecoLinha(base)).toBe(
      'RUA DAS FLORES, 1000, SALA 2 - CENTRO - SAO PAULO - SP, CEP: 01001-000',
    );
  });

  it('drops missing segments without leaving dangling separators', () => {
    const partial: DanfeEndereco = {
      logradouro: 'RUA B',
      numero: '',
      complemento: null,
      bairro: '',
      municipio: 'RIO DE JANEIRO',
      uf: 'RJ',
      cep: '',
      fone: null,
    };
    const line = enderecoLinha(partial);
    expect(line).toBe('RUA B - RIO DE JANEIRO - RJ');
    expect(line).not.toMatch(/ - -|, ,| {2}/); // no doubled/empty separators
    expect(line).not.toMatch(/^[\s,-]|[\s,-]$/); // no leading/trailing separator
  });
});
