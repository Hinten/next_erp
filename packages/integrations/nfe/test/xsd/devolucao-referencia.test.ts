/**
 * The devolução shapes the live lane sends to SEFAZ (#1683), pinned OFFLINE
 * against the vendored XSD first — a fixture mistake must fail here, never
 * spend a call at the rate-limited homologação endpoint.
 *
 * NT 2025.002 v1.51 VC02-14 (cStat 321) moves a devolução's reference from the
 * note (`ide/NFref/refNFe`) to the item (`det/DFeReferenciado`). Both groups
 * are schema-valid either way: what SEFAZ accepts is a RULE question, which is
 * what the live cases answer. This file pins only the wire the fixture builds.
 *
 * The generator emits an UNSIGNED `<NFe>` and the schema requires
 * `<Signature>`, so that one error is filtered out; every other error counts.
 */
import { describe, expect, it } from 'vitest';

import { generateNFe } from '../../src/generator';
import { NFeXsdValidationError, validateXsd } from '../../src/xsd';
import {
  buildHomologacaoFixture,
  impostoCsosn102ComRtc,
  type HomologacaoFixtureOpts,
} from '../helpers/homologacao-fixture';

/** Every XSD error of one generated XML, except the missing `<Signature>`. */
async function errosXsd(nfeXml: string): Promise<string[]> {
  try {
    await validateXsd('NFe', nfeXml);
    return [];
  } catch (err) {
    if (err instanceof NFeXsdValidationError) {
      return err.errors.map((e) => e.message).filter((m) => !m.includes('Signature'));
    }
    throw err;
  }
}

const BASE = { serie: 4, cnpj: '99999999000191', ie: '111111111' } as const;

/** The origin saída — two lines, as the live case emits it. */
const ORIGEM = generateNFe(
  buildHomologacaoFixture({
    ...BASE,
    numeracao: 1,
    itens: [
      { cProd: 'SKU-A', vUnCom: 1500 },
      { cProd: 'SKU-B', vUnCom: 700 },
    ],
  }),
);

function devolucao(over: Partial<HomologacaoFixtureOpts> = {}): string {
  return generateNFe(
    buildHomologacaoFixture({
      ...BASE,
      numeracao: 2,
      devolucao: true,
      itens: [{ cProd: 'SKU-A', vUnCom: 1500 }],
      ...over,
    }),
  ).nfeXml;
}

const REF_ITEM_1 = { chaveAcesso: ORIGEM.chave, nItem: 1 };

describe('devolução fixture — the wire the live lane sends (#1683)', () => {
  it('the origin saída is valid and carries both lines', async () => {
    expect(ORIGEM.nfeXml).toContain('<det nItem="1">');
    expect(ORIGEM.nfeXml).toContain('<det nItem="2">');
    expect(await errosXsd(ORIGEM.nfeXml)).toEqual([]);
  });

  it('the preset is an interstate entrada de devolução with no payment, billing or intermediador', () => {
    const xml = devolucao({ chNFeReferenciadas: [ORIGEM.chave] });
    expect(xml).toContain('<tpNF>0</tpNF>');
    expect(xml).toContain('<idDest>2</idDest>');
    expect(xml).toContain('<finNFe>4</finNFe>');
    expect(xml).toContain('<indIntermed>0</indIntermed>');
    // 2202, never 1202 — the old B25-70 exemption list (see the fixture).
    expect(xml).toContain('<CFOP>2202</CFOP>');
    expect(xml).not.toContain('<CFOP>1202</CFOP>');
    expect(xml).toContain('<detPag><tPag>90</tPag><vPag>0.00</vPag></detPag>');
    expect(xml).not.toContain('<cobr>');
    expect(xml).not.toContain('<infIntermed>');
    expect(xml).toMatch(/<enderDest>.*<UF>RJ<\/UF>.*<\/enderDest>/);
  });

  it.each([
    ['RTC off', {}],
    ['RTC on', { imposto: impostoCsosn102ComRtc(), emitRtc: true }],
  ] as const)('NFref only (%s) is schema-valid', async (_rotulo, rtc) => {
    const xml = devolucao({ ...rtc, chNFeReferenciadas: [ORIGEM.chave] });
    expect(xml).toContain(`<NFref><refNFe>${ORIGEM.chave}</refNFe></NFref>`);
    expect(xml).not.toContain('<DFeReferenciado>');
    expect(await errosXsd(xml)).toEqual([]);
  });

  it.each([
    ['RTC off', {}],
    ['RTC on', { imposto: impostoCsosn102ComRtc(), emitRtc: true }],
  ] as const)('DFeReferenciado only (%s) is schema-valid', async (_rotulo, rtc) => {
    const xml = devolucao({
      ...rtc,
      itens: [{ cProd: 'SKU-A', vUnCom: 1500, dfeReferenciado: REF_ITEM_1 }],
    });
    expect(xml).toContain(
      `<DFeReferenciado><chaveAcesso>${ORIGEM.chave}</chaveAcesso><nItem>1</nItem></DFeReferenciado></det>`,
    );
    expect(xml).not.toContain('<NFref>');
    expect(await errosXsd(xml)).toEqual([]);
  });

  it('two lines with only the first referenced is schema-valid', async () => {
    const xml = devolucao({
      imposto: impostoCsosn102ComRtc(),
      emitRtc: true,
      itens: [
        { cProd: 'SKU-A', vUnCom: 1500, dfeReferenciado: REF_ITEM_1 },
        { cProd: 'SKU-B', vUnCom: 700 },
      ],
    });
    expect(xml.match(/<DFeReferenciado>/g)).toHaveLength(1);
    expect(await errosXsd(xml)).toEqual([]);
  });

  it('the default fixture is unchanged by the new options: one line, a saída, PIX with cobr', () => {
    const xml = generateNFe(buildHomologacaoFixture({ ...BASE, numeracao: 3 })).nfeXml;
    expect(xml.match(/<det nItem=/g)).toHaveLength(1);
    expect(xml).toContain('<cProd>SKU-A</cProd>');
    expect(xml).toContain('<tpNF>1</tpNF>');
    expect(xml).toContain('<CFOP>5102</CFOP>');
    expect(xml).toContain('<tPag>17</tPag><vPag>1500.00</vPag>');
    expect(xml).toContain('<vLiq>1500.00</vLiq>');
  });
});
