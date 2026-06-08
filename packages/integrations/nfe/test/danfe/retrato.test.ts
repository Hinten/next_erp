import { describe, expect, it } from 'vitest';

import { renderDanfe } from '../../src/danfe';
import { parseProcNFe } from '../../src/danfe/model';
import { composeInfoComplementares, paginate, renderRetrato } from '../../src/danfe/pdf/retrato';
import { PROCNFE_FIXTURE } from './fixtures';

const pageCount = (pdf: Buffer): number =>
  (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
const REF_CHAVE = '35260514200166000187550010000000061000000010';

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

  it('renders 100 itens with infCpl + infAdFisco across multiple pages', async () => {
    const big = {
      ...model,
      itens: Array.from({ length: 100 }, () => model.itens[0]!),
      infAdic: {
        infCpl: 'Informação complementar de teste para múltiplas páginas.',
        infAdFisco: 'Reservado ao fisco: observação fiscal de teste.',
      },
    };
    const pdf = await renderRetrato(big);
    expect(isPdf(pdf)).toBe(true);
    expect(pageCount(pdf)).toBeGreaterThan(1);
    expect(composeInfoComplementares(big)).toContain('Informação complementar');
  });

  it('puts a referenced chNFe (NFref) into informações complementares', () => {
    const withRef = { ...model, ide: { ...model.ide, refNFes: [REF_CHAVE] } };
    const info = composeInfoComplementares(withRef);
    expect(info).toContain(`NFref. ${REF_CHAVE}`);
    expect(info).toContain(model.infAdic.infCpl!); // infCpl still present
  });

  it('paginates a max-length infCpl (5000 chars) across pages instead of clipping', async () => {
    const big = { ...model, infAdic: { infCpl: 'PALAVRA '.repeat(625), infAdFisco: null } };
    const pdf = await renderRetrato(big);
    expect(isPdf(pdf)).toBe(true);
    expect(pageCount(pdf)).toBeGreaterThan(1); // the infCpl alone forces extra pages
  });

  it('spills a very long infCpl onto multiple continuation pages', async () => {
    const big = { ...model, infAdic: { infCpl: 'LOREM IPSUM '.repeat(1500), infAdFisco: null } };
    expect(pageCount(await renderRetrato(big))).toBeGreaterThan(2);
  });

  it('keeps a short infCpl on a single page', async () => {
    const small = { ...model, infAdic: { infCpl: 'Observação curta de teste.', infAdFisco: 'Fisco.' } };
    expect(pageCount(await renderRetrato(small))).toBe(1);
  });

  it('renders transportadora + local de entrega/retirada', async () => {
    const local = (tag: string): string =>
      `<${tag}><xNome>LOCAL ${tag.toUpperCase()}</xNome><CNPJ>11222333000181</CNPJ>` +
      `<xLgr>RUA EXEMPLO</xLgr><nro>10</nro><xBairro>CENTRO</xBairro><cMun>3550308</cMun>` +
      `<xMun>SAO PAULO</xMun><UF>SP</UF><CEP>01001000</CEP></${tag}>`;
    const xml = PROCNFE_FIXTURE.replace('</dest>', `</dest>${local('retirada')}${local('entrega')}`);
    const m2 = parseProcNFe(xml);
    expect(m2.retirada?.nome).toBe('LOCAL RETIRADA');
    expect(m2.entrega?.nome).toBe('LOCAL ENTREGA');
    expect(m2.transp.transportadorNome).toBe('TRANSPORTADORA EXEMPLO LTDA');
    expect(m2.transp.veicPlaca).toBe('ABC1D23');
    expect(isPdf(await renderRetrato(m2))).toBe(true);
  });

  it('paginate never yields a 0-row page and the slices sum to n', () => {
    const cases: Array<[number, number, number, number, number]> = [
      [9, 10, 8, 12, 10], // n between rowsFirstLast+1 and rowsFirstFull (the old 0/neg-row bug)
      [1, 10, 8, 12, 10],
      [8, 10, 8, 12, 10],
      [50, 10, 8, 12, 10],
      [25, 10, 10, 10, 10],
      [11, 10, 8, 12, 10],
    ];
    for (const [n, ff, fl, of, ol] of cases) {
      const slices = paginate(n, ff, fl, of, ol);
      expect(slices.reduce((a, b) => a + b, 0)).toBe(n);
      for (const s of slices) expect(s).toBeGreaterThanOrEqual(1);
    }
  });
});
