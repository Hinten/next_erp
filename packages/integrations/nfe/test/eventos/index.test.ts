import { describe, it, expect } from 'vitest';

import {
  buildCancelamentoEvento,
  buildCCeEvento,
  buildEnvEvento,
  buildEpecDetEvento,
  buildEpecEvento,
  buildProcEventoNFe,
  C_ORGAO_AMBIENTE_NACIONAL,
  extractEpecInputFromNFe,
  NFeEventoError,
  TP_EVENTO_CANCELAMENTO,
  TP_EVENTO_CCE,
  TP_EVENTO_EPEC,
  XCONDUSO_CCE,
  type EpecEventoInput,
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

// ---------------------------------------------------------------------------
// EPEC — tpEvento 110140 (Ambiente Nacional)
// ---------------------------------------------------------------------------

function epecInput(): EpecEventoInput {
  return {
    chNFe: CHAVE,
    tpAmb: '2' as const,
    cnpj: CNPJ,
    ie: '110042490114',
    cOrgaoAutor: '35',
    verAplic: 'erp-next 1.0',
    dhEmi: '2026-06-11T08:30:00-03:00',
    tpNF: '1',
    dest: {
      uf: 'SP',
      cnpj: '99999999000191',
      ie: '222222222',
      vNF: '1234.56',
      vICMS: '0.00',
      vST: '0.00',
    },
  };
}

describe('buildEpecEvento', () => {
  it('builds the Id as ID + tpEvento(110140)(6) + chNFe(44) + nSeqEvento(2)', () => {
    const xml = buildEpecEvento(epecInput());
    expect(xml).toContain(`<infEvento Id="ID${TP_EVENTO_EPEC}${CHAVE}01">`);
    const id = /Id="(ID[^"]+)"/.exec(xml)![1]!;
    expect(id).toHaveLength(2 + 6 + 44 + 2);
  });

  it('fixes cOrgao at 91 — the Ambiente Nacional, regardless of the issuer UF', () => {
    const xml = buildEpecEvento(epecInput());
    expect(C_ORGAO_AMBIENTE_NACIONAL).toBe('91');
    expect(xml).toContain('<cOrgao>91</cOrgao>');
    // cOrgaoAutor (inside detEvento) still carries the issuer's cUF.
    expect(xml).toContain('<cOrgaoAutor>35</cOrgaoAutor>');
  });

  it('throws NFeEventoError when chNFe is not 44 digits', () => {
    expect(() => buildEpecEvento({ ...epecInput(), chNFe: '123' })).toThrow(NFeEventoError);
  });
});

describe('buildEpecDetEvento', () => {
  it('emits the e110140 fields in XSD order with the dest summary', () => {
    const xml = buildEpecDetEvento(epecInput());
    expect(xml).toContain('<detEvento versao="1.00">');
    const order = [
      '<descEvento>EPEC</descEvento>',
      '<cOrgaoAutor>35</cOrgaoAutor>',
      '<tpAutor>1</tpAutor>',
      '<verAplic>erp-next 1.0</verAplic>',
      '<dhEmi>2026-06-11T08:30:00-03:00</dhEmi>',
      '<tpNF>1</tpNF>',
      '<IE>110042490114</IE>',
      '<dest>',
      '<UF>SP</UF>',
      '<CNPJ>99999999000191</CNPJ>',
      '<IE>222222222</IE>',
      '<vNF>1234.56</vNF>',
      '<vICMS>0.00</vICMS>',
      '<vST>0.00</vST>',
    ];
    let cursor = -1;
    for (const tag of order) {
      const at = xml.indexOf(tag, cursor + 1);
      expect(at, `${tag} present and after the previous field`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('emits CPF instead of CNPJ for a pessoa-física destinatário', () => {
    const xml = buildEpecDetEvento({
      ...epecInput(),
      dest: { uf: 'SP', cpf: '12345678909', vNF: '50.00', vICMS: '0.00', vST: '0.00' },
    });
    expect(xml).toContain('<CPF>12345678909</CPF>');
    // The emitter IE still rides outside <dest>; only the dest CNPJ/IE are gone.
    expect(xml).not.toContain('<CNPJ>');
    expect(xml).not.toContain('<IE>222222222</IE>');
  });

  it('emits idEstrangeiro + UF EX for a foreign buyer', () => {
    const xml = buildEpecDetEvento({
      ...epecInput(),
      dest: { uf: 'EX', idEstrangeiro: 'EX998877', vNF: '50.00', vICMS: '0.00', vST: '0.00' },
    });
    expect(xml).toContain('<UF>EX</UF>');
    expect(xml).toContain('<idEstrangeiro>EX998877</idEstrangeiro>');
  });
});

describe('extractEpecInputFromNFe', () => {
  /** A signed-NFe slice with the fields the EPEC summary projects. */
  function nfeXml(opts: { dest?: string; emit?: string } = {}): string {
    const emit = opts.emit ?? '<emit><CNPJ>14200166000187</CNPJ><IE>110042490114</IE></emit>';
    const dest =
      opts.dest ??
      '<dest><CNPJ>99999999000191</CNPJ><enderDest><UF>SP</UF></enderDest><IE>222222222</IE></dest>';
    return (
      `<NFe xmlns="${NFE_NS}"><infNFe Id="NFe${CHAVE}" versao="4.00">` +
      '<ide><cUF>35</cUF><mod>55</mod><serie>1</serie><nNF>7</nNF>' +
      '<dhEmi>2026-06-11T08:30:00-03:00</dhEmi><tpNF>1</tpNF><tpEmis>4</tpEmis>' +
      '<tpAmb>2</tpAmb><verProc>erp-next 1.0</verProc></ide>' +
      emit +
      dest +
      '<total><ICMSTot><vICMS>0.10</vICMS><vST>0.20</vST><vNF>1234.56</vNF></ICMSTot></total>' +
      '</infNFe><Signature>…</Signature></NFe>'
    );
  }

  it('projects emit/ide/dest/ICMSTot into the EPEC summary (round-trips into the builder)', () => {
    const input = extractEpecInputFromNFe(nfeXml(), { tpAmb: '2' });
    expect(input.chNFe).toBe(CHAVE);
    expect(input.cnpj).toBe(CNPJ);
    expect(input.ie).toBe('110042490114');
    expect(input.cOrgaoAutor).toBe('35');
    expect(input.verAplic).toBe('erp-next 1.0');
    expect(input.dhEmi).toBe('2026-06-11T08:30:00-03:00');
    expect(input.tpNF).toBe('1');
    expect(input.dest).toEqual({
      uf: 'SP',
      cnpj: '99999999000191',
      cpf: undefined,
      idEstrangeiro: undefined,
      ie: '222222222',
      vNF: '1234.56',
      vICMS: '0.10',
      vST: '0.20',
    });
    // The projection feeds the builder without further massaging.
    const det = buildEpecDetEvento(input);
    expect(det).toContain('<descEvento>EPEC</descEvento>');
    expect(det).toContain('<vNF>1234.56</vNF>');
  });

  it("maps a foreign buyer (idEstrangeiro) to dest UF 'EX'", () => {
    const input = extractEpecInputFromNFe(
      nfeXml({ dest: '<dest><idEstrangeiro>EX998877</idEstrangeiro></dest>' }),
      { tpAmb: '2' },
    );
    expect(input.dest.uf).toBe('EX');
    expect(input.dest.idEstrangeiro).toBe('EX998877');
  });

  it('throws NFeEventoError when the NF-e has no <dest>', () => {
    expect(() => extractEpecInputFromNFe(nfeXml({ dest: '' }), { tpAmb: '2' })).toThrow(
      NFeEventoError,
    );
  });

  it('throws NFeEventoError when the emitter lacks CNPJ or IE', () => {
    expect(() =>
      extractEpecInputFromNFe(nfeXml({ emit: '<emit><CNPJ>14200166000187</CNPJ></emit>' }), {
        tpAmb: '2',
      }),
    ).toThrow(NFeEventoError);
  });

  it("throws a CLEAR NFeEventoError for emitter IE='ISENTO' (legal in the NF-e, not in e110140)", () => {
    expect(() =>
      extractEpecInputFromNFe(
        nfeXml({ emit: '<emit><CNPJ>14200166000187</CNPJ><IE>ISENTO</IE></emit>' }),
        { tpAmb: '2' },
      ),
    ).toThrow(/numeric emitter IE.*ISENTO/);
  });

  it("omits a non-numeric dest IE ('ISENTO') — optional in e110140, must not break the XSD gate", () => {
    const input = extractEpecInputFromNFe(
      nfeXml({
        dest: '<dest><CNPJ>99999999000191</CNPJ><enderDest><UF>SP</UF></enderDest><IE>ISENTO</IE></dest>',
      }),
      { tpAmb: '2' },
    );
    expect(input.dest.ie).toBeUndefined();
    expect(buildEpecDetEvento(input)).not.toContain('ISENTO');
  });

  it('throws NFeEventoError when the dest carries no CNPJ, CPF or idEstrangeiro', () => {
    // The e110140 <dest> choice REQUIRES one of the three; a clear typed
    // error here beats the opaque XSD failure downstream.
    expect(() =>
      extractEpecInputFromNFe(
        nfeXml({ dest: '<dest><enderDest><UF>SP</UF></enderDest><IE>222222222</IE></dest>' }),
        { tpAmb: '2' },
      ),
    ).toThrow(/destinatário identification/);
  });

  it('throws NFeEventoError when the dest has neither enderDest.UF nor idEstrangeiro', () => {
    expect(() =>
      extractEpecInputFromNFe(nfeXml({ dest: '<dest><CNPJ>99999999000191</CNPJ></dest>' }), {
        tpAmb: '2',
      }),
    ).toThrow(NFeEventoError);
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
