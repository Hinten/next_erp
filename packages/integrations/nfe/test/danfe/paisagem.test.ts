import { describe, expect, it } from 'vitest';

import { renderDanfe } from '../../src/danfe';
import { parseProcNFe } from '../../src/danfe/model';
import { renderPaisagem } from '../../src/danfe/pdf/paisagem';
import { PROCNFE_FIXTURE } from './fixtures';
import { isPdf, pageCount, REF_CHAVE } from './helpers';

describe('danfe/pdf paisagem (A4 landscape)', () => {
  const model = parseProcNFe(PROCNFE_FIXTURE);

  it('renders a non-trivial landscape PDF', async () => {
    const pdf = await renderPaisagem(model);
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(2000);
  });

  it('paginates a large item list across multiple sheets', async () => {
    const many = { ...model, itens: Array.from({ length: 120 }, () => model.itens[0]!) };
    const pdf = await renderPaisagem(many);
    expect(isPdf(pdf)).toBe(true);
    expect(pageCount(pdf)).toBeGreaterThan(1);
  });

  it('renders the cancelada overlay variant without throwing', async () => {
    const pdf = await renderPaisagem(model, { cancelada: true });
    expect(isPdf(pdf)).toBe(true);
  });

  it('renders via the public renderDanfe entry (format=paisagem)', async () => {
    const pdf = await renderDanfe(PROCNFE_FIXTURE, { format: 'paisagem' });
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
    const pdf = await renderPaisagem(big);
    expect(isPdf(pdf)).toBe(true);
    expect(pageCount(pdf)).toBeGreaterThan(1);
  });

  it('renders a referenced chNFe (NFref) without throwing', async () => {
    const withRef = { ...model, ide: { ...model.ide, refNFes: [REF_CHAVE] } };
    expect(isPdf(await renderPaisagem(withRef))).toBe(true);
  });

  it('paginates a max-length infCpl (5000 chars) across pages instead of clipping', async () => {
    const big = { ...model, infAdic: { infCpl: 'PALAVRA '.repeat(625), infAdFisco: null } };
    const pdf = await renderPaisagem(big);
    expect(isPdf(pdf)).toBe(true);
    expect(pageCount(pdf)).toBeGreaterThan(1); // the infCpl alone forces extra pages
  });

  it('keeps a short infCpl on a single page', async () => {
    const small = {
      ...model,
      infAdic: { infCpl: 'Observação curta de teste.', infAdFisco: 'Fisco.' },
    };
    expect(pageCount(await renderPaisagem(small))).toBe(1);
  });

  it('renders transportadora + local de entrega/retirada', async () => {
    const local = (tag: string): string =>
      `<${tag}><xNome>LOCAL ${tag.toUpperCase()}</xNome><CNPJ>11222333000181</CNPJ>` +
      `<xLgr>RUA EXEMPLO</xLgr><nro>10</nro><xBairro>CENTRO</xBairro><cMun>3550308</cMun>` +
      `<xMun>SAO PAULO</xMun><UF>SP</UF><CEP>01001000</CEP></${tag}>`;
    const xml = PROCNFE_FIXTURE.replace(
      '</dest>',
      `</dest>${local('retirada')}${local('entrega')}`,
    );
    const m2 = parseProcNFe(xml);
    expect(m2.entrega?.nome).toBe('LOCAL ENTREGA');
    expect(isPdf(await renderPaisagem(m2))).toBe(true);
  });
});
