import { describe, it, expect } from 'vitest';
import forge from 'node-forge';
import type {
  Cliente,
  Endereco,
  Filial,
  Imposto,
  ModoGruposImposto,
  Operacao,
  TpNFDebito,
} from '@delfrance/schemas';

import { signNFe } from '../../src/sign';
import { validateXsd } from '../../src/xsd';
import type { NFeCertificate } from '../../src/cert';
import { generateNFe, NFeGeneratorError } from '../../src/generator/index';
import { NFeIdeError } from '../../src/generator/ide';
import { HOMOLOGACAO_XNOME } from '../../src/generator/parties';
import { aggregateTotals, buildImpostoXml, buildTotalXml } from '../../src/tribute/index';
import type { GeneratorInput, GeneratorItem } from '../../src/generator/types';
import {
  IND_INTERMED_OPERACAO,
  IND_PRES_OPERACAO,
  MODO_GRUPOS_IMPOSTO,
  ORIGEM,
  TIPO_CLIENTE,
  TP_NF_CREDITO,
  TP_NF_DEBITO,
  UF_SIGLA,
  cClassTribDoTipo,
  grupoDeAjusteDoTipo,
  modoGruposImposto,
} from '@delfrance/schemas';

const FILIAL: Filial = {
  razaoSocial: 'Loja de Bicicletas Acmé S.A.',
  fantasia: 'Bike Açaí',
  cnae: '4763602',
  cnpj: '14200166000187',
  ie: '111111111111',
  iest: null,
  imun: null,
  ultimaModificacao: null,
  sede: {
    idExterno: null,
    logradouro: 'Rua Direita',
    numero: '100',
    bairro: 'Centro',
    complemento: 'Sala 1@2',
    cep: '01001000',
    codigoMunicipio: '3550308',
    cidade: 'São Paulo',
    estado: UF_SIGLA.SP,
    cPais: null,
    pais: null,
    nome: null,
    cpf_cnpj: null,
    rg: null,
    ie: null,
    imun: null,
    email: null,
    telefone: null,
    timestamp: null,
    ultimaModificacao: null,
  },
};

const CLIENTE: Cliente = {
  tipo: TIPO_CLIENTE.pessoaJuridica,
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
  telefonesAdicionais: [],
  telefoneGerenciado: false,
  observacoesInternas: null,
  timestamp: null,
  userCliente: null,
  idMercadoLivre: null,
  ultimaModificacao: null,
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
  estado: UF_SIGLA.SP,
  cPais: null,
  pais: null,
  nome: null,
  cpf_cnpj: null,
  rg: null,
  ie: null,
  imun: null,
  email: null,
  telefone: null,
  timestamp: null,
  ultimaModificacao: null,
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
  tpNFDebito: null,
  tpNFCredito: null,
  indPres: IND_PRES_OPERACAO.naoPresencialInternet,
  indIntermed: IND_INTERMED_OPERACAO.semIntermediador,
  cfop: '5102',
  cfopInterestadual: '6102',
  NCM: null,
  CEST: null,
  unidade: null,
  infCpl: null,
  ultimaModificacao: null,
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

    it('throws on a malformed chave before contacting SEFAZ', () => {
      expect(() => generateNFe({ ...BASE_INPUT, chNFeReferenciadas: ['123'] })).toThrow(
        /chNFeReferenciada inválida/,
      );
    });

    // ⚠️ "44 digits" stopped being the rule with NT 2026.004: positions 6–17 of
    // a chave are the emitente CNPJ's body, which may now be alphanumeric. The
    // guard delegates to the shared CHAVE_NFE_REGEX, so a chave from a
    // counterparty with an alfa CNPJ must pass while a letter outside that
    // window must not. See test/xsd/cnpj-alfanumerico.test.ts for the pair.
    it('rejects a 44-character chave with a letter outside the CNPJ body', () => {
      expect(() =>
        generateNFe({ ...BASE_INPUT, chNFeReferenciadas: [`${'1'.repeat(43)}A`] }),
      ).toThrow(/chNFeReferenciada inválida/);
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

/**
 * #422 — the delivery address decides `idDest` AND rides as `<entrega>`.
 *
 * SEFAZ judges `idDest` against `enderDest/UF`, or against `entrega/UF` when
 * the group is present (772/773/523), so the two must come from ONE input:
 * `enderecoEntrega` present ⇒ both; absent ⇒ neither.
 */
describe('generateNFe — delivery address (enderecoEntrega, #422)', () => {
  const ENTREGA_RJ: Endereco = {
    ...ENDERECO_DEST,
    logradouro: 'Rua do Ouvidor',
    numero: '50',
    bairro: 'Centro',
    cep: '20040030',
    codigoMunicipio: '3304557',
    cidade: 'Rio de Janeiro',
    estado: UF_SIGLA.RJ,
    nome: 'Maria Recebedora',
    cpf_cnpj: '52998224725',
  };
  const DEST_RJ: Endereco = { ...ENTREGA_RJ, nome: null, cpf_cnpj: null };
  const ENTREGA_SP: Endereco = { ...ENDERECO_DEST, nome: 'Joao', cpf_cnpj: '11144477735' };
  // `cnae: null` — the unrelated emit-sequence quirk of the shared FILIAL
  // fixture (see the contingência block) would fail the XSD for another reason.
  const XSD_INPUT: GeneratorInput = { ...BASE_INPUT, filial: { ...FILIAL, cnae: null } };

  const idDestOf = (xml: string) => /<idDest>(\d)<\/idDest>/.exec(xml)?.[1];
  const enderDestUF = (xml: string) => /<enderDest>.*?<UF>([A-Z]{2})<\/UF>/.exec(xml)?.[1];

  // [label, fiscal address, delivery address, ehExterior, expected idDest] —
  // the emitente is SP throughout.
  const CASES: Array<[string, Endereco, Endereco | null, boolean, string]> = [
    ['fiscal SP, no delivery', ENDERECO_DEST, null, false, '1'],
    ['fiscal RJ, no delivery', DEST_RJ, null, false, '2'],
    ['fiscal SP, delivery RJ', ENDERECO_DEST, ENTREGA_RJ, false, '2'],
    ['fiscal RJ, delivery SP', DEST_RJ, ENTREGA_SP, false, '1'],
    ['fiscal RJ, delivery RJ', DEST_RJ, ENTREGA_RJ, false, '2'],
    ['exterior wins over a delivery UF', ENDERECO_DEST, ENTREGA_RJ, true, '3'],
  ];

  it.each(CASES)('%s → idDest %s', (_label, dest, entrega, ehExterior, expected) => {
    const out = generateNFe({
      ...BASE_INPUT,
      operacao: { ...OPERACAO, ehExterior },
      enderecoDest: dest,
      enderecoEntrega: entrega,
    });
    expect(idDestOf(out.nfeXml)).toBe(expected);
  });

  it('keeps <enderDest> on the FISCAL address while idDest follows the delivery', () => {
    const out = generateNFe({ ...BASE_INPUT, enderecoEntrega: ENTREGA_RJ });
    expect(idDestOf(out.nfeXml)).toBe('2');
    expect(enderDestUF(out.nfeXml)).toBe('SP');
  });

  it('places <entrega> between </dest> and the first <det> (XSD order)', () => {
    const out = generateNFe({ ...BASE_INPUT, enderecoEntrega: ENTREGA_RJ });
    expect(out.nfeXml).toMatch(/<\/dest><entrega><CPF>52998224725<\/CPF>.*<\/entrega><det /);
    expect(out.nfeXml).toContain('<UF>RJ</UF><CEP>20040030</CEP></entrega>');
  });

  it('a signed nota with a CPF recebedor passes the NFe XSD', async () => {
    const out = generateNFe({ ...XSD_INPUT, enderecoEntrega: ENTREGA_RJ });
    const signed = signNFe(out.nfeXml, fixtureCertificate());
    await expect(validateXsd('NFe', signed)).resolves.toBeUndefined();
  });

  it('a signed nota with the cliente CNPJ as fallback identity passes the NFe XSD', async () => {
    const out = generateNFe({
      ...XSD_INPUT,
      enderecoEntrega: { ...ENTREGA_RJ, nome: null, cpf_cnpj: null },
    });
    expect(out.nfeXml).toContain(`<entrega><CNPJ>${CLIENTE.cpf_cnpj}</CNPJ>`);
    const signed = signNFe(out.nfeXml, fixtureCertificate());
    await expect(validateXsd('NFe', signed)).resolves.toBeUndefined();
  });

  it('without a delivery address the XML is byte-identical and has no <entrega>', () => {
    const plain = generateNFe(BASE_INPUT);
    expect(plain.nfeXml).not.toContain('<entrega>');
    expect(generateNFe({ ...BASE_INPUT, enderecoEntrega: null }).nfeXml).toBe(plain.nfeXml);
  });
});

/**
 * #330 — `det/DFeReferenciado` (NT 2025.002 Grupo VC), the item of another NF-e
 * a line refers to. It is the LAST child of `<det>`, and absent means the det
 * is byte-identical.
 */
describe('generateNFe — det/DFeReferenciado (#330)', () => {
  const CHAVE = '35260514200166000187550010000000071000000011';
  const CHAVE_ALFA = '352601ABCDEFGHIJKL87550010000001234567890120';
  const XSD_INPUT: GeneratorInput = { ...BASE_INPUT, filial: { ...FILIAL, cnae: null } };
  const comRef = (dfeReferenciado: GeneratorItem['dfeReferenciado']): GeneratorInput => ({
    ...XSD_INPUT,
    itens: [{ ...ITEM, dfeReferenciado }],
  });

  it('emits chaveAcesso + nItem after </imposto>, closing the det', () => {
    const out = generateNFe(comRef({ chaveAcesso: CHAVE, nItem: 3 }));
    expect(out.nfeXml).toContain(
      `</imposto><DFeReferenciado><chaveAcesso>${CHAVE}</chaveAcesso><nItem>3</nItem></DFeReferenciado></det>`,
    );
  });

  it.each([
    ['with nItem', { chaveAcesso: CHAVE, nItem: 3 }],
    ['without nItem', { chaveAcesso: CHAVE }],
    ['nItem 990 (the XSD maximum)', { chaveAcesso: CHAVE, nItem: 990 }],
    ['an alphanumeric-CNPJ chave', { chaveAcesso: CHAVE_ALFA, nItem: 1 }],
  ])('a signed nota %s passes the NFe XSD', async (_label, ref) => {
    const signed = signNFe(generateNFe(comRef(ref)).nfeXml, fixtureCertificate());
    await expect(validateXsd('NFe', signed)).resolves.toBeUndefined();
  });

  it('refuses what the XSD would, naming the item', () => {
    expect(() => generateNFe(comRef({ chaveAcesso: '123', nItem: 1 }))).toThrow(
      /item 1: DFeReferenciado\.chaveAcesso/,
    );
    for (const nItem of [0, 991, 1.5]) {
      expect(() => generateNFe(comRef({ chaveAcesso: CHAVE, nItem }))).toThrow(
        /DFeReferenciado\.nItem must be an integer from 1 to 990/,
      );
    }
  });

  it('without a reference the det is byte-identical', () => {
    expect(generateNFe(comRef(undefined)).nfeXml).toBe(generateNFe(XSD_INPUT).nfeXml);
    expect(generateNFe(XSD_INPUT).nfeXml).not.toContain('<DFeReferenciado>');
  });
});

describe('generateNFe — nota de crédito / débito (finNFe 5/6, #330)', () => {
  const XSD_INPUT: GeneratorInput = { ...BASE_INPUT, filial: { ...FILIAL, cnae: null } };
  const IMPOSTO_RTC: Imposto = {
    origem: ORIGEM.nacional,
    configuracaoICMS: { crt: '1', csosn: '102' },
    configuracaoIBSCBS: { CST: '000', cClassTrib: '000001', pIBSUF: 0.1, pIBSMun: 0, pCBS: 0.9 },
  };

  /** A whole nota the way apps/nfe builds it: the det and the total from one mode. */
  function nota(
    operacao: Partial<Operacao>,
    grupos: ModoGruposImposto = MODO_GRUPOS_IMPOSTO.somenteIbsCbs,
  ) {
    const opts = { emitRtc: true, grupos };
    const totals = aggregateTotals([{ item: { vProd: 1500 }, imposto: IMPOSTO_RTC }], {}, opts);
    return {
      ...XSD_INPUT,
      operacao: { ...OPERACAO, ...operacao },
      itens: [{ ...ITEM, impostoXml: buildImpostoXml(IMPOSTO_RTC, { vProd: 1500 }, opts) }],
      totalXml: buildTotalXml(totals),
      pagXml: '<pag><detPag><tPag>90</tPag><vPag>0.00</vPag></detPag></pag>',
    };
  }

  it('débito 06 (pagamento antecipado): tpNFDebito after finNFe, IBS/CBS only, XSD-valid', async () => {
    const out = generateNFe(nota({ finNFe: 6, tpNFDebito: TP_NF_DEBITO.pagamentoAntecipado }));
    expect(out.nfeXml).toContain('<finNFe>6</finNFe><tpNFDebito>06</tpNFDebito><indFinal>');
    expect(out.nfeXml).not.toContain('<ICMS>');
    expect(out.nfeXml).toContain('<vNFTot>1515.00</vNFTot>');
    const signed = signNFe(out.nfeXml, fixtureCertificate());
    await expect(validateXsd('NFe', signed)).resolves.toBeUndefined();
  });

  it.each([
    ['01', MODO_GRUPOS_IMPOSTO.somenteIbsCbs],
    ['03', MODO_GRUPOS_IMPOSTO.completo],
    ['04', MODO_GRUPOS_IMPOSTO.completo],
  ] as const)('crédito %s (an entrada) is XSD-valid in its mode', async (tp, grupos) => {
    const out = generateNFe(nota({ finNFe: 5, tipo: 0, tpNFCredito: tp }, grupos));
    expect(out.nfeXml).toContain(`<finNFe>5</finNFe><tpNFCredito>${tp}</tpNFCredito>`);
    expect(out.nfeXml).toContain('<tpNF>0</tpNF>');
    expect(out.nfeXml.includes('<ICMS>')).toBe(grupos === MODO_GRUPOS_IMPOSTO.completo);
    const signed = signNFe(out.nfeXml, fixtureCertificate());
    await expect(validateXsd('NFe', signed)).resolves.toBeUndefined();
  });

  it('refuses an ide SEFAZ would reject on the tipo alone (B25.1 / B25.2 / B25-110)', () => {
    expect(() => generateNFe(nota({ finNFe: 6 }))).toThrow(NFeIdeError);
    expect(() => generateNFe(nota({ finNFe: 6 }))).toThrow(/tipo da nota de débito.*1009/);
    expect(() => generateNFe(nota({ finNFe: 1, tpNFDebito: TP_NF_DEBITO.multaJuros }))).toThrow(
      /1139/,
    );
    expect(() => generateNFe(nota({ finNFe: 5, tpNFCredito: TP_NF_CREDITO.multaJuros }))).toThrow(
      /1161/,
    );
  });

  it('1145 is judged on the emission year in the emitente time zone', () => {
    const credito02 = nota({ finNFe: 5, tipo: 0, tpNFCredito: TP_NF_CREDITO.creditoPresumidoZfm });
    // 2029-01-01 00:30 in São Paulo: 2029 (UTC agrees).
    const virada = new Date('2029-01-01T00:30:00-03:00');
    expect(() => generateNFe({ ...credito02, dhEmi: virada })).not.toThrow();
    // Near-miss: 2028-12-31 23:30 in São Paulo is already 2029 in UTC, and still 2028 here.
    const vespera = new Date('2028-12-31T23:30:00-03:00');
    expect(() => generateNFe({ ...credito02, dhEmi: vespera })).toThrow(/1145/);
  });

  it('a normal nota is byte-identical — no tipo field appears', () => {
    const out = generateNFe(XSD_INPUT).nfeXml;
    expect(out).not.toContain('<tpNFDebito>');
    expect(out).not.toContain('<tpNFCredito>');
  });
});

describe('generateNFe — nota de débito with an IBS/CBS adjustment group (#330, part 3)', () => {
  const XSD_INPUT: GeneratorInput = { ...BASE_INPUT, filial: { ...FILIAL, cnae: null } };

  /** The produto's own RTC config — which an adjustment item must NOT read. */

  const IMPOSTO: Imposto = {
    origem: ORIGEM.nacional,

    configuracaoICMS: { crt: '1', csosn: '102' },

    configuracaoIBSCBS: { CST: '000', cClassTrib: '000001', pIBSUF: 0.1, pIBSMun: 0, pCBS: 0.9 },
  };

  /** A whole nota de débito the way apps/nfe builds it: the tipo decides group and mode. */

  function debito(
    tpNFDebito: TpNFDebito,
    valores: { vIBS: number; vCBS: number; competApur?: string },
  ) {
    const t = { finNFe: 6, tpNFDebito, tpNFCredito: null };

    const grupos = modoGruposImposto(t);

    const ajuste = {
      cClassTrib: cClassTribDoTipo(t)!,

      grupo: grupoDeAjusteDoTipo(t)!,

      vIBS: valores.vIBS,

      vCBS: valores.vCBS,

      competApur: valores.competApur ?? null,
    };

    const opts = { emitRtc: true, grupos, ajuste };

    const totals = aggregateTotals([{ item: { vProd: 1500 }, imposto: IMPOSTO, ajuste }], {}, opts);

    return {
      ...XSD_INPUT,

      operacao: { ...OPERACAO, finNFe: 6 as const, tpNFDebito },

      itens: [{ ...ITEM, impostoXml: buildImpostoXml(IMPOSTO, { vProd: 1500 }, opts) }],

      totalXml: buildTotalXml(totals),

      pagXml: '<pag><detPag><tPag>90</tPag><vPag>0.00</vPag></detPag></pag>',
    };
  }

  const xsdValid = async (input: GeneratorInput) =>
    expect(
      validateXsd('NFe', signNFe(generateNFe(input).nfeXml, fixtureCertificate())),
    ).resolves.toBeUndefined();

  it.each([
    [TP_NF_DEBITO.transferenciaCreditoCooperativa, '800', '800002'],

    [TP_NF_DEBITO.transferenciaCreditoSucessao, '800', '800001'],
  ] as const)(
    'débito %s: CST %s / %s + gTransfCred alone, XSD-valid',
    async (tp, cst, cClassTrib) => {
      const input = debito(tp, { vIBS: 12.34, vCBS: 56.78 });

      const xml = generateNFe(input).nfeXml;

      expect(xml).toContain(
        `<IBSCBS><CST>${cst}</CST><cClassTrib>${cClassTrib}</cClassTrib>` +
          '<gTransfCred><vIBS>12.34</vIBS><vCBS>56.78</vCBS></gTransfCred></IBSCBS>',
      );

      // The produto's own classification and rates never reach the wire.

      expect(xml).not.toContain('<gIBSCBS>');

      expect(xml).not.toContain('<cClassTrib>000001</cClassTrib>');

      expect(xml).not.toContain('<ICMS>');

      await xsdValid(input);
    },
  );

  it.each([
    [TP_NF_DEBITO.anulacaoCreditoSaidaImuneIsenta, '811001'],

    [TP_NF_DEBITO.debitoNotaNaoProcessada, '811002'],

    [TP_NF_DEBITO.desenquadramentoSimples, '811003'],
  ] as const)(
    'débito %s: CST 811 / %s + gAjusteCompet with competApur, XSD-valid',
    async (tp, cClassTrib) => {
      const input = debito(tp, { vIBS: 1, vCBS: 9, competApur: '2026-04' });

      expect(generateNFe(input).nfeXml).toContain(
        `<IBSCBS><CST>811</CST><cClassTrib>${cClassTrib}</cClassTrib><gAjusteCompet>` +
          '<competApur>2026-04</competApur><vIBS>1.00</vIBS><vCBS>9.00</vCBS></gAjusteCompet></IBSCBS>',
      );

      await xsdValid(input);
    },
  );

  it('débito 07: ICMS stays (B25-80 exception), IBSCBS carries gEstornoCred, the total its W59e group', async () => {
    const input = debito(TP_NF_DEBITO.perdaEstoque, { vIBS: 3.21, vCBS: 28.9 });

    const xml = generateNFe(input).nfeXml;

    expect(xml).toContain('<ICMS>');

    expect(xml).toContain(
      '<IBSCBS><CST>410</CST><cClassTrib>410030</cClassTrib><gEstornoCred>' +
        '<vIBSEstCred>3.21</vIBSEstCred><vCBSEstCred>28.90</vCBSEstCred></gEstornoCred></IBSCBS>',
    );

    expect(xml).toMatch(
      /<IBSCBSTot>.*<gEstornoCred><vIBSEstCred>3\.21<\/vIBSEstCred><vCBSEstCred>28\.90<\/vCBSEstCred><\/gEstornoCred><\/IBSCBSTot>/,
    );

    await xsdValid(input);
  });

  it('adjustment amounts never enter IBSCBSTot vIBS/vCBS (W47/W56 sum gIBSCBS only)', () => {
    const xml = generateNFe(
      debito(TP_NF_DEBITO.transferenciaCreditoSucessao, { vIBS: 10, vCBS: 90 }),
    ).nfeXml;

    expect(xml).toMatch(/<IBSCBSTot><vBCIBSCBS>0\.00<\/vBCIBSCBS>/);

    expect(xml).toContain('<vIBS>0.00</vIBS><vCredPres>');

    expect(xml).toContain('<vNFTot>1500.00</vNFTot>');

    expect(xml).not.toContain('<gEstornoCred><vIBSEstCred>');
  });

  it('refuses what the wire cannot carry', () => {
    const t = {
      finNFe: 6,
      tpNFDebito: TP_NF_DEBITO.anulacaoCreditoSaidaImuneIsenta,
      tpNFCredito: null,
    };

    const ajuste = { cClassTrib: '811001', grupo: grupoDeAjusteDoTipo(t)!, vIBS: 1, vCBS: 1 };

    const somente = { emitRtc: true, grupos: modoGruposImposto(t) };

    // gAjusteCompet without a real competência.

    for (const competApur of [null, '2026-13']) {
      expect(() =>
        buildImpostoXml(IMPOSTO, { vProd: 1 }, { ...somente, ajuste: { ...ajuste, competApur } }),
      ).toThrow(/competApur as AAAA-MM/);
    }

    // The RTC off.

    expect(() =>
      buildImpostoXml(
        IMPOSTO,
        { vProd: 1 },
        { emitRtc: false, ajuste: { ...ajuste, competApur: '2026-01' } },
      ),
    ).toThrow(/emit the Reforma Tributária/);

    expect(() =>
      aggregateTotals(
        [{ item: { vProd: 1 }, imposto: IMPOSTO, ajuste: { ...ajuste, competApur: '2026-01' } }],
        {},
        {},
      ),
    ).toThrow(/emit the Reforma Tributária/);

    // A negative amount.

    expect(() =>
      buildImpostoXml(
        IMPOSTO,
        { vProd: 1 },
        { ...somente, ajuste: { ...ajuste, vIBS: -1, competApur: '2026-01' } },
      ),
    ).toThrow();
  });

  it('near-miss: without an ajuste the same item keeps its ordinary gIBSCBS', () => {
    const xml = buildImpostoXml(IMPOSTO, { vProd: 1500 }, { emitRtc: true });

    expect(xml).toContain('<gIBSCBS>');

    expect(xml).toContain('<cClassTrib>000001</cClassTrib>');
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
