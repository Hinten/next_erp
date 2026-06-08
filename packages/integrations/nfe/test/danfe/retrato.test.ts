import { describe, expect, it } from 'vitest';

import { renderDanfe } from '../../src/danfe';
import { parseProcNFe } from '../../src/danfe/model';
import { renderRetrato } from '../../src/danfe/pdf/retrato';
import { PROCNFE_FIXTURE } from './fixtures';

const isPdf = (buf: Buffer): boolean => buf.subarray(0, 5).toString('latin1') === '%PDF-';

describe('danfe/pdf retrato (A4)', () => {
  const model = parseProcNFe(PROCNFE_FIXTURE);

  it('maps the itens with the extracted CST/CSOSN + ICMS columns', () => {
    expect(model.itens).toHaveLength(2);
    expect(model.itens[0]?.cstCsosn).toBe('102'); // Simples Nacional CSOSN
    expect(model.itens[0]?.vBcIcms).toBe('0'); // SN → no ICMS base
    expect(model.itens[1]?.cEAN).toBe('7891234567890');
    expect(model.transp.modFrete).toBe('1');
    expect(model.transp.veicPlaca).toBe('ABC1D23');
  });

  it('renders a non-trivial A4 PDF', async () => {
    const pdf = await renderRetrato(model);
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(2000);
  });

  it('paginates a large item list across multiple sheets', async () => {
    const many = { ...model, itens: Array.from({ length: 120 }, () => model.itens[0]!) };
    const pdf = await renderRetrato(many);
    expect(isPdf(pdf)).toBe(true);
    // A 120-row table cannot fit on one A4 sheet → the PDF must carry >1 page.
    const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pageCount).toBeGreaterThan(1);
  });

  it('renders the cancelada overlay variant without throwing', async () => {
    const pdf = await renderRetrato(model, { cancelada: true });
    expect(isPdf(pdf)).toBe(true);
  });

  it('renders via the public renderDanfe entry (format=retrato)', async () => {
    const pdf = await renderDanfe(PROCNFE_FIXTURE, { format: 'retrato' });
    expect(isPdf(pdf)).toBe(true);
  });
});
