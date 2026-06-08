import { describe, it, expect } from 'vitest';

import {
  buildCancelamentoEvento,
  buildCCeEvento,
  buildEnvEvento,
  buildProcEventoNFe,
  NFeEventoError,
  TP_EVENTO_CANCELAMENTO,
  TP_EVENTO_CCE,
  XCONDUSO_CCE,
} from '../../src/eventos/index';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const CHAVE = '35200714200166000187550010000000071000000018';
const CNPJ = '14200166000187';
const NPROT = '135200000012345';

function baseInput() {
  return {
    chNFe: CHAVE,
    cOrgao: '35',
    cnpj: CNPJ,
    nProt: NPROT,
    xJust: 'Cancelamento por erro de digitacao no pedido',
    tpAmb: '2' as const,
  };
}

describe('buildCancelamentoEvento', () => {
  it('builds the Id as ID + tpEvento(6) + chNFe(44) + nSeqEvento(2)', () => {
    const xml = buildCancelamentoEvento(baseInput());
    expect(xml).toContain(`<infEvento Id="ID${TP_EVENTO_CANCELAMENTO}${CHAVE}01">`);
    // ID(2) + 110111(6) + chave(44) + nSeq(2) = 54 chars after the literal "Id=\"".
    const id = /Id="(ID[^"]+)"/.exec(xml)![1]!;
    expect(id).toHaveLength(2 + 6 + 44 + 2);
  });

  it('throws NFeEventoError when chNFe is not 44 digits', () => {
    expect(() => buildCancelamentoEvento({ ...baseInput(), chNFe: '123' })).toThrow(NFeEventoError);
  });

  it('emits the infEvento children in XSD order', () => {
    const xml = buildCancelamentoEvento(baseInput());
    const order = [
      '<cOrgao>',
      '<tpAmb>',
      '<CNPJ>',
      '<chNFe>',
      '<dhEvento>',
      '<tpEvento>',
      '<nSeqEvento>',
      '<verEvento>',
      '<detEvento',
    ];
    let cursor = -1;
    for (const tag of order) {
      const at = xml.indexOf(tag);
      expect(at, `${tag} present`).toBeGreaterThan(-1);
      expect(at, `${tag} after previous`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('builds the detEvento with descEvento Cancelamento + nProt + xJust', () => {
    const xml = buildCancelamentoEvento(baseInput());
    expect(xml).toContain('<detEvento versao="1.00">');
    expect(xml).toContain('<descEvento>Cancelamento</descEvento>');
    expect(xml).toContain(`<nProt>${NPROT}</nProt>`);
    expect(xml).toContain('<xJust>Cancelamento por erro de digitacao no pedido</xJust>');
  });

  it('XML-escapes the xJust', () => {
    const xml = buildCancelamentoEvento({
      ...baseInput(),
      xJust: 'Erro & engano <grave> no pedido teste',
    });
    expect(xml).toContain('Erro &amp; engano &lt;grave&gt; no pedido teste');
    expect(xml).not.toContain('<grave>');
  });

  it("defaults nSeqEvento to 1 (padded to '01' in the Id)", () => {
    const xml = buildCancelamentoEvento(baseInput());
    expect(xml).toContain('<nSeqEvento>1</nSeqEvento>');
    expect(xml).toMatch(/Id="ID110111\d{44}01"/);
  });

  it('honors an explicit nSeqEvento', () => {
    const xml = buildCancelamentoEvento({ ...baseInput(), nSeqEvento: 2 });
    expect(xml).toContain('<nSeqEvento>2</nSeqEvento>');
    expect(xml).toMatch(/Id="ID110111\d{44}02"/);
  });

  it('emits dhEvento as issuer-local ISO with a UTC offset', () => {
    const xml = buildCancelamentoEvento(baseInput());
    const dh = /<dhEvento>([^<]+)<\/dhEvento>/.exec(xml)![1]!;
    expect(dh).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it('wraps the evento in the NFe namespace + versao 1.00', () => {
    const xml = buildCancelamentoEvento(baseInput());
    expect(xml).toMatch(new RegExp(`^<evento xmlns="${NFE_NS}" versao="1.00">`));
    expect(xml.endsWith('</evento>')).toBe(true);
  });
});

describe('buildCCeEvento', () => {
  function cceInput() {
    return {
      chNFe: CHAVE,
      cOrgao: '35',
      cnpj: CNPJ,
      xCorrecao: 'Correcao do peso bruto informado no campo de transporte',
      tpAmb: '2' as const,
    };
  }

  it('builds the Id as ID + tpEvento(110110)(6) + chNFe(44) + nSeqEvento(2)', () => {
    const xml = buildCCeEvento(cceInput());
    expect(xml).toContain(`<infEvento Id="ID${TP_EVENTO_CCE}${CHAVE}01">`);
    const id = /Id="(ID[^"]+)"/.exec(xml)![1]!;
    expect(id).toHaveLength(2 + 6 + 44 + 2);
  });

  it('throws NFeEventoError when chNFe is not 44 digits', () => {
    expect(() => buildCCeEvento({ ...cceInput(), chNFe: '123' })).toThrow(NFeEventoError);
  });

  it('builds the detEvento (descEvento + xCorrecao + fixed xCondUso) in XSD order', () => {
    const xml = buildCCeEvento(cceInput());
    expect(xml).toContain('<detEvento versao="1.00">');
    expect(xml).toContain('<descEvento>Carta de Correção</descEvento>');
    expect(xml).toContain(
      '<xCorrecao>Correcao do peso bruto informado no campo de transporte</xCorrecao>',
    );
    expect(xml).toContain(`<xCondUso>${XCONDUSO_CCE}</xCondUso>`);
    const desc = xml.indexOf('<descEvento>');
    const corr = xml.indexOf('<xCorrecao>');
    const cond = xml.indexOf('<xCondUso>');
    expect(desc).toBeLessThan(corr);
    expect(corr).toBeLessThan(cond);
  });

  it('XML-escapes the xCorrecao', () => {
    const xml = buildCCeEvento({ ...cceInput(), xCorrecao: 'Troca de A & B por <C> teste real' });
    expect(xml).toContain('Troca de A &amp; B por &lt;C&gt; teste real');
    expect(xml).not.toContain('<C>');
  });

  it('honors an explicit nSeqEvento (padded in the Id)', () => {
    const xml = buildCCeEvento({ ...cceInput(), nSeqEvento: 3 });
    expect(xml).toContain('<nSeqEvento>3</nSeqEvento>');
    expect(xml).toMatch(/Id="ID110110\d{44}03"/);
  });

  it('carries no nProt in the CC-e detEvento', () => {
    const xml = buildCCeEvento(cceInput());
    expect(xml).not.toContain('<nProt>');
  });
});

describe('buildEnvEvento', () => {
  const SIGNED_EVENTO =
    `<evento xmlns="${NFE_NS}" versao="1.00">` +
    `<infEvento Id="ID110111${CHAVE}01">…</infEvento>` +
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">…sig…</Signature>` +
    `</evento>`;

  it("defaults idLote to '1' and splices the signed evento verbatim", () => {
    const xml = buildEnvEvento(SIGNED_EVENTO);
    expect(xml).toMatch(new RegExp(`^<envEvento xmlns="${NFE_NS}" versao="1.00">`));
    expect(xml).toContain('<idLote>1</idLote>');
    // The signed evento must survive byte-for-byte — re-serialization breaks
    // the digest.
    expect(xml).toContain(SIGNED_EVENTO);
    expect(xml.endsWith('</envEvento>')).toBe(true);
  });

  it('honors a custom idLote', () => {
    const xml = buildEnvEvento(SIGNED_EVENTO, '42');
    expect(xml).toContain('<idLote>42</idLote>');
  });

  it('strips a leading XML declaration off the signed evento', () => {
    const xml = buildEnvEvento(`<?xml version="1.0" encoding="UTF-8"?>${SIGNED_EVENTO}`);
    expect(xml).not.toContain('<?xml');
    expect(xml).toContain(SIGNED_EVENTO);
  });
});

describe('buildProcEventoNFe', () => {
  const SIGNED_EVENTO =
    `<evento xmlns="${NFE_NS}" versao="1.00">` +
    `<infEvento Id="ID110111${CHAVE}01">…</infEvento>` +
    `<Signature>…sig…</Signature>` +
    `</evento>`;
  const RET_EVENTO =
    `<retEvento versao="1.00">` +
    `<infEvento Id="ID...">` +
    `<tpAmb>2</tpAmb><cStat>135</cStat>` +
    `<xMotivo>Evento registrado e vinculado a NF-e</xMotivo>` +
    `<nProt>135200000099999</nProt>` +
    `</infEvento>` +
    `</retEvento>`;

  it('stitches the signed evento + the verbatim retEvento into procEventoNFe', () => {
    const raw =
      `<retEnvEvento xmlns="${NFE_NS}" versao="1.00"><idLote>1</idLote>` +
      `<cStat>128</cStat><xMotivo>Lote processado</xMotivo>${RET_EVENTO}</retEnvEvento>`;
    const proc = buildProcEventoNFe(SIGNED_EVENTO, raw);
    expect(proc).not.toBeNull();
    expect(proc).toContain('<procEventoNFe');
    expect(proc).toContain(SIGNED_EVENTO);
    // retEvento is lifted verbatim (SEFAZ's own signature on it is preserved).
    expect(proc).toContain(RET_EVENTO);
  });

  it('returns null when the response carries no retEvento (lote rejection)', () => {
    const raw =
      `<retEnvEvento xmlns="${NFE_NS}" versao="1.00"><idLote>1</idLote>` +
      `<cStat>215</cStat><xMotivo>Falha no schema XML</xMotivo></retEnvEvento>`;
    expect(buildProcEventoNFe(SIGNED_EVENTO, raw)).toBeNull();
  });
});
