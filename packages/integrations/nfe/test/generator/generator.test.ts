import { describe, it, expect } from 'vitest';
import forge from 'node-forge';
import type { Cliente, Endereco, Filial, Operacao } from '@delfrance/schemas';

import { signNFe } from '../../src/sign';
import { validateXsd } from '../../src/xsd';
import type { NFeCertificate } from '../../src/cert';
import { generateNFe, NFeGeneratorError } from '../../src/generator/index';
import { HOMOLOGACAO_XNOME } from '../../src/generator/parties';
import type { GeneratorInput, GeneratorItem } from '../../src/generator/types';

const FILIAL: Filial = {
  razaoSocial: 'Loja de Bicicletas Acmé S.A.',
  fantasia: 'Bike Açaí',
  cnae: '4763602',
  cnpj: '14200166000187',
  ie: '111111111111',
  iest: null,
  imun: null,
  sede: {
    idExterno: null,
    logradouro: 'Rua Direita',
    numero: '100',
    bairro: 'Centro',
    complemento: 'Sala 1@2',
    cep: '01001000',
    codigoMunicipio: '3550308',
    cidade: 'São Paulo',
    estado: 'SP',
    cPais: null,
    pais: null,
    nome: null,
    cpf_cnpj: null,
    rg: null,
    ie: null,
    imun: null,
    email: null,
    telefone: null,
  },
};

const CLIENTE: Cliente = {
  tipo: '1',
  nome: 'Distribuidora André & Cia. Ltda.',
  cpf_cnpj: '99999999000191',
  idEstrangeiro: null,
  ie: '222222222',
  imun: null,
  // Present so the signed-XSD round-trips below prove <ISUF> is accepted in
  // its XSD slot (indIEDest → IE → ISUF → IM), not just that it carries the
  // right value — see fidelity.test.ts for the ordering assertion.
  isUF: '123456789',
  email: null,
  telefone: null,
  observacoesInternas: null,
  timestamp: null,
  nome_embedding: null,
  telefone_embedding: null,
  userCliente: null,
};

const ENDERECO_DEST: Endereco = {
  idExterno: null,
  logradouro: 'Av. Brasil',
  numero: '500',
  bairro: 'Jardins',
  complemento: null,
  cep: '04504010',
  codigoMunicipio: '3550308',
  cidade: 'São Paulo',
  estado: 'SP',
  cPais: null,
  pais: null,
  nome: null,
  cpf_cnpj: null,
  rg: null,
  ie: null,
  imun: null,
  email: null,
  telefone: null,
};

const OPERACAO: Operacao = {
  nome: 'Venda mercadoria UF',
  naturezaDaOperacao: 'Venda de mercadoria adquirida ou recebida de terceiros',
  tipo: 1,
  ehServico: false,
  ehExterior: false,
  ehConsumidorFinal: false,
  padrao: false,
  ativo: true,
  movimentaEstoque: true,
  movimentaIndisponivelEstoque: true,
  ehFiscal: true,
  finNFe: 1,
  indPres: '2',
  indIntermed: '0',
  cfop: '5102',
  cfopInterestadual: '6102',
  NCM: null,
  CEST: null,
  unidade: null,
  infCpl: null,
};

const ITEM: GeneratorItem = {
  nItem: 1,
  cProd: 'BIKE-001',
  cEAN: 'SEM GTIN',
  xProd: 'Bicicleta Aro 29',
  NCM: '87120000',
  CFOP: '5102',
  uCom: 'UN',
  qCom: 1,
  vUnCom: 1500,
  vProd: 1500,
  cEANTrib: 'SEM GTIN',
  uTrib: 'UN',
  qTrib: 1,
  vUnTrib: 1500,
  impostoXml:
    '<imposto><ICMS><ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>1500.00</vBC><pICMS>18.00</pICMS><vICMS>270.00</vICMS></ICMS00></ICMS></imposto>',
};

const TOTAL_XML =
  '<total><ICMSTot><vBC>1500.00</vBC><vICMS>270.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>1500.00</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>1500.00</vNF></ICMSTot></total>';

const TRANSP_XML = '<transp><modFrete>9</modFrete></transp>';

const PAG_XML = '<pag><detPag><tPag>03</tPag><vPag>1500.00</vPag></detPag></pag>';

const BASE_INPUT: GeneratorInput = {
  ambiente: 'homologacao',
  numeracao: 7,
  serie: 1,
  tpEmis: 1,
  // Explicit instant (not local-time components) so the suite is deterministic
  // on any runner TZ — the generator formats in the FILIAL's offset (#395).
  dhEmi: new Date('2026-05-20T10:30:00-03:00'),
  filial: FILIAL,
  operacao: OPERACAO,
  cliente: CLIENTE,
  enderecoDest: ENDERECO_DEST,
  itens: [ITEM],
  totalXml: TOTAL_XML,
  transpXml: TRANSP_XML,
  pagXml: PAG_XML,
  cNF: '00000001',
};

describe('generateNFe', () => {
  it('returns a deterministic chave when cNF is supplied', () => {
    const out = generateNFe(BASE_INPUT);
    expect(out.chave).toHaveLength(44);
    expect(out.chave).toMatch(/^\d{44}$/);
    expect(out.cNF).toBe('00000001');
    // cUF=35, AAMM=2605, CNPJ=14200166000187, mod=55, série=001, nNF=000000007, tpEmis=1, cNF=00000001.
    expect(out.chave.slice(0, 43)).toBe('3526051420016600018755001000000007100000001');
  });

  it('stamps the infNFe Id with `NFe` + chave', () => {
    const out = generateNFe(BASE_INPUT);
    expect(out.nfeXml).toContain(`<infNFe Id="NFe${out.chave}" versao="4.00">`);
  });

  it('formats dhEmi in the FILIAL UF offset regardless of the process TZ (#395)', () => {
    // The instant is 13:30Z; the filial is SP (-03:00) → the wire wall-clock
    // must be 10:30-03:00 on ANY runner (UTC CI included), and the chave AAMM
    // must agree with the dhEmi string.
    const out = generateNFe(BASE_INPUT);
    expect(out.nfeXml).toContain('<dhEmi>2026-05-20T10:30:00-03:00</dhEmi>');
    expect(out.chave.slice(2, 6)).toBe('2605');
  });

  it('month boundary: an instant that is next-month in UTC stays in the SP month (#395)', () => {
    // 2026-07-01T01:30Z = 2026-06-30 22:30 BRT → dhEmi + chave AAMM say JUNE.
    const out = generateNFe({ ...BASE_INPUT, dhEmi: new Date('2026-07-01T01:30:00Z') });
    expect(out.nfeXml).toContain('<dhEmi>2026-06-30T22:30:00-03:00</dhEmi>');
    expect(out.chave.slice(2, 6)).toBe('2606');
  });

  it('wraps in <NFe xmlns="…/nfe"> with no formatting whitespace', () => {
    const out = generateNFe(BASE_INPUT);
    expect(out.nfeXml).toMatch(/^<NFe xmlns="http:\/\/www\.portalfiscal\.inf\.br\/nfe">/);
    expect(out.nfeXml).not.toMatch(/>\s+</);
  });

  it('stamps the homologação xNome and tpAmb=2', () => {
    const out = generateNFe(BASE_INPUT);
    expect(out.nfeXml).toContain(`<xNome>${HOMOLOGACAO_XNOME}</xNome>`);
    expect(out.nfeXml).toContain('<tpAmb>2</tpAmb>');
    // Real cliente name must NOT leak through in homologação.
    expect(out.nfeXml).not.toContain('Andre');
  });

  it('uses the real cliente xNome in produção', () => {
    const out = generateNFe({ ...BASE_INPUT, ambiente: 'producao' });
    expect(out.nfeXml).toContain('<tpAmb>1</tpAmb>');
    // sanitised: accent stripped, & still raw (the XML serializer escapes it).
    expect(out.nfeXml).toContain('Distribuidora Andre &amp; Cia. Ltda.');
    expect(out.nfeXml).not.toContain(HOMOLOGACAO_XNOME);
  });

  it('sanitises restricted characters in emit xCpl', () => {
    const out = generateNFe(BASE_INPUT);
    // `@` is in the restricted set — `Sala 1@2` → `Sala 12`.
    expect(out.nfeXml).toContain('<xCpl>Sala 12</xCpl>');
  });

  it('emits one <det> per item with sequential nItem', () => {
    const out = generateNFe({
      ...BASE_INPUT,
      itens: [
        { ...ITEM, nItem: 1, cProd: 'A' },
        { ...ITEM, nItem: 2, cProd: 'B' },
      ],
    });
    expect(out.nfeXml).toContain('<det nItem="1">');
    expect(out.nfeXml).toContain('<det nItem="2">');
    expect(out.nfeXml).toContain('<cProd>A</cProd>');
    expect(out.nfeXml).toContain('<cProd>B</cProd>');
  });

  it('splices the caller-built imposto / total / transp / pag XML verbatim', () => {
    const out = generateNFe(BASE_INPUT);
    expect(out.nfeXml).toContain(ITEM.impostoXml);
    expect(out.nfeXml).toContain(TOTAL_XML);
    expect(out.nfeXml).toContain(TRANSP_XML);
    expect(out.nfeXml).toContain(PAG_XML);
  });

  it('rejects empty items list', () => {
    expect(() => generateNFe({ ...BASE_INPUT, itens: [] })).toThrow(NFeGeneratorError);
  });

  it('rejects non-positive numeracao', () => {
    expect(() => generateNFe({ ...BASE_INPUT, numeracao: 0 })).toThrow(NFeGeneratorError);
  });

  it('rejects serie outside [0, 889]', () => {
    expect(() => generateNFe({ ...BASE_INPUT, serie: 999 })).toThrow(NFeGeneratorError);
  });

  describe('contingência (tpEmis ≠ 1 → dhCont/xJust, B28/B29)', () => {
    const XJUST = 'SEFAZ-SP indisponivel desde as 08h de hoje';
    const CONT_INPUT: GeneratorInput = {
      ...BASE_INPUT,
      // The XSD allows <CNAE> only after <IM> — the shared FILIAL fixture has
      // cnae without imun, which trips the (unrelated) emit sequence in the
      // signed-XSD check below. Not a contingency concern; drop cnae here.
      filial: { ...FILIAL, cnae: null },
      tpEmis: 6,
      // Explicit instant — 08:00 in the filial's (SP) offset on ANY runner TZ.
      dhCont: new Date('2026-06-10T08:00:00-03:00'),
      xJust: XJUST,
    };

    it('bakes the contingency tpEmis into the chave (digit 35)', () => {
      const out = generateNFe(CONT_INPUT);
      expect(out.chave[34]).toBe('6');
      expect(out.nfeXml).toContain('<tpEmis>6</tpEmis>');
    });

    it('emits dhCont then xJust right after verProc (XSD order)', () => {
      const out = generateNFe(CONT_INPUT);
      expect(out.nfeXml).toMatch(
        /<verProc>[^<]*<\/verProc><dhCont>2026-06-10T08:00:00[^<]*<\/dhCont><xJust>SEFAZ-SP indisponivel desde as 08h de hoje<\/xJust><\/ide>/,
      );
    });

    it('emits NO dhCont/xJust for normal emission', () => {
      const out = generateNFe(BASE_INPUT);
      expect(out.nfeXml).not.toContain('<dhCont>');
      expect(out.nfeXml).not.toContain('<xJust>');
    });

    it('rejects contingency input missing dhCont or xJust', () => {
      expect(() => generateNFe({ ...CONT_INPUT, dhCont: undefined })).toThrow(NFeGeneratorError);
      expect(() => generateNFe({ ...CONT_INPUT, xJust: undefined })).toThrow(NFeGeneratorError);
    });

    it('rejects an xJust shorter than 15 chars after sanitisation', () => {
      expect(() => generateNFe({ ...CONT_INPUT, xJust: 'curta demais' })).toThrow(/15.255|15–255/);
    });

    it('signed contingency NF-e passes the NFe XSD', async () => {
      const out = generateNFe(CONT_INPUT);
      const signed = signNFe(out.nfeXml, fixtureCertificate());
      await expect(validateXsd('NFe', signed)).resolves.toBeUndefined();
    });

    it('rejects dhCont/xJust on a normal (tpEmis=1) emission', () => {
      expect(() => generateNFe({ ...BASE_INPUT, dhCont: new Date(), xJust: XJUST })).toThrow(
        /forbidden/,
      );
    });
  });

  it('produces XML the signer accepts (xml-crypto round-trip)', () => {
    const cert = fixtureCertificate();
    const out = generateNFe(BASE_INPUT);
    const signed = signNFe(out.nfeXml, cert);
    expect(signed).toContain(`URI="#NFe${out.chave}"`);
    expect(signed).toMatch(/<\/infNFe><Signature[\s>]/);
  });

  describe('NFref — referenced NF-es (devolução / complementar)', () => {
    const REF_A = '35260514200166000187550010000000011000000010';
    const REF_B = '35260514200166000187550010000000021000000027';

    it('emits ide.NFref[].refNFe for each chave', () => {
      const out = generateNFe({ ...BASE_INPUT, chNFeReferenciadas: [REF_A, REF_B] });
      expect(out.nfeXml).toContain(`<NFref><refNFe>${REF_A}</refNFe></NFref>`);
      expect(out.nfeXml).toContain(`<NFref><refNFe>${REF_B}</refNFe></NFref>`);
    });

    it('the NFref ide group is XSD-valid (positioned correctly at the end of ide)', async () => {
      // `cnae: null` avoids the unrelated FILIAL-fixture emit-sequence quirk (see
      // the contingência block); NFref rides at the end of <ide>.
      const out = generateNFe({
        ...BASE_INPUT,
        filial: { ...FILIAL, cnae: null },
        chNFeReferenciadas: [REF_A],
      });
      expect(out.nfeXml).toContain(`<NFref><refNFe>${REF_A}</refNFe></NFref>`);
      const signed = signNFe(out.nfeXml, fixtureCertificate());
      await expect(validateXsd('NFe', signed)).resolves.toBeUndefined();
    });

    it('emits no NFref when the list is empty or absent (byte-identical ide)', () => {
      const withEmpty = generateNFe({ ...BASE_INPUT, chNFeReferenciadas: [] });
      expect(withEmpty.nfeXml).not.toContain('<NFref>');
      expect(generateNFe(BASE_INPUT).nfeXml).not.toContain('<NFref>');
    });

    it('throws on a malformed chave (not 44 digits) before contacting SEFAZ', () => {
      expect(() => generateNFe({ ...BASE_INPUT, chNFeReferenciadas: ['123'] })).toThrow(
        /44 dígitos/,
      );
    });
  });

  describe('cliente.ie sentinels reach neither the XML nor SEFAZ', () => {
    // `cliente.ie` is free text carrying the IE_SENTINELA tokens. The generator
    // used to emit it verbatim, so `<IE>Não contribuinte</IE>` reached the
    // SIGNED XML — the XSD's TIeDestNaoIsento is `[0-9]{2,14}`, so the note was
    // malformed before SEFAZ ever saw it. Signed end-to-end because the XSD
    // rejects an unsigned <NFe> outright.
    it.each(['Não contribuinte', 'NAO CONTRIBUINTE', 'ISENTO', '110.042.490.114', null])(
      'a signed NF-e for a cliente with ie=%j passes the NFe XSD',
      async (ie) => {
        const out = generateNFe({
          ...BASE_INPUT,
          // `cnae: null` avoids the unrelated FILIAL-fixture emit-sequence
          // quirk (see the contingência block).
          filial: { ...FILIAL, cnae: null },
          cliente: { ...CLIENTE, ie },
        });
        const signed = signNFe(out.nfeXml, fixtureCertificate());
        await expect(validateXsd('NFe', signed)).resolves.toBeUndefined();
      },
    );
  });
});

/** Self-signed cert for the offline signer round-trip. */
function fixtureCertificate(): NFeCertificate {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'GEN TEST' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem: forge.pki.certificateToPem(cert),
    certificateDerBase64: forge.util.encode64(
      forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(),
    ),
    subjectCommonName: 'GEN TEST:99999999000191',
    cnpj: '99999999000191',
    notAfter: cert.validity.notAfter,
    pfxBuffer: Buffer.from(''),
    password: '',
  };
}
