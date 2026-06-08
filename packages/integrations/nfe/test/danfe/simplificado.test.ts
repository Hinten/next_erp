import { describe, expect, it } from 'vitest';

import { renderDanfe, renderDanfeZpl } from '../../src/danfe';
import { parseProcNFe } from '../../src/danfe/model';
import { renderSimplificado } from '../../src/danfe/pdf/simplificado';
import { PROCNFE_FIXTURE } from './fixtures';

const isPdf = (buf: Buffer): boolean => buf.subarray(0, 5).toString('latin1') === '%PDF-';

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

  it('throws for the not-yet-implemented paisagem format', () => {
    expect(() => renderDanfe(PROCNFE_FIXTURE, { format: 'paisagem' })).toThrow(/not implemented/i);
  });

  it('renderDanfeZpl returns a ZPL string', () => {
    expect(renderDanfeZpl(PROCNFE_FIXTURE)).toContain('^XA');
  });
});
