/**
 * PL_010f_v1.04 (NT 2025.002 v1.50/v1.51 + NT 2026.007 v1.00) — what the pack
 * changed that this repo relies on, or must not regress, pinned against the
 * VENDORED XSD. Each change has a case the new pack accepts and a near-miss it
 * still refuses, so a later pack that moves one of them fails here by name.
 *
 * The generator emits an UNSIGNED `<NFe>` and the schema requires `<Signature>`,
 * so the one error about the missing signature is filtered out; every other
 * error counts.
 */
import { describe, expect, it } from 'vitest';
import { FIN_NFE_OPERACAO, MODO_GRUPOS_IMPOSTO, TP_NF_CREDITO } from '@delfrance/schemas';

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

/** A valid RTC nota from the shared homologação fixture. */
function notaRtc(over: Partial<HomologacaoFixtureOpts> = {}) {
  return generateNFe(
    buildHomologacaoFixture({
      numeracao: 1,
      serie: 2,
      cnpj: '99999999000191',
      ie: '111111111',
      imposto: impostoCsosn102ComRtc(),
      emitRtc: true,
      ...over,
    }),
  ).nfeXml;
}

/** Replace exactly one occurrence, failing loudly when the anchor is absent. */
function trocar(xml: string, de: string, para: string): string {
  expect(xml, `anchor ${de}`).toContain(de);
  return xml.replace(de, para);
}

describe('PL_010f — the vendored pack', () => {
  it('the baseline RTC nota is valid (only the signature is missing)', async () => {
    expect(await errosXsd(notaRtc())).toEqual([]);
  });

  it('tpNFCredito 06 (retorno por recusa parcial) is accepted; 07 is not', async () => {
    const credito06 = notaRtc({
      grupos: MODO_GRUPOS_IMPOSTO.completo,
      operacao: {
        tipo: 0,
        finNFe: FIN_NFE_OPERACAO.credito,
        tpNFCredito: TP_NF_CREDITO.retornoRecusaParcial,
      },
    });
    expect(credito06).toContain('<finNFe>5</finNFe><tpNFCredito>06</tpNFCredito>');
    expect(await errosXsd(credito06)).toEqual([]);
    const credito07 = trocar(
      credito06,
      '<tpNFCredito>06</tpNFCredito>',
      '<tpNFCredito>07</tpNFCredito>',
    );
    expect(await errosXsd(credito07)).not.toEqual([]);
  });

  it('ide/cIndOp (6 digits) sits between indIntermed and procEmi', async () => {
    const xml = notaRtc();
    const comCIndOp = trocar(xml, '<procEmi>', '<cIndOp>355030</cIndOp><procEmi>');
    expect(await errosXsd(comCIndOp)).toEqual([]);
    expect(await errosXsd(trocar(xml, '<procEmi>', '<cIndOp>35503</cIndOp><procEmi>'))).not.toEqual(
      [],
    );
  });

  it('emit/ISUFEmit (8–9 digits) closes the emit group; emit/IE is now optional', async () => {
    const xml = notaRtc();
    const crt = /<CRT>\d<\/CRT>/.exec(xml)![0];
    expect(await errosXsd(trocar(xml, crt, `${crt}<ISUFEmit>200123456</ISUFEmit>`))).toEqual([]);
    expect(await errosXsd(trocar(xml, crt, `${crt}<ISUFEmit>2001234</ISUFEmit>`))).not.toEqual([]);
    const ieEmit = /<emit>.*?(<IE>[^<]*<\/IE>)/.exec(xml)![1]!;
    expect(await errosXsd(trocar(xml, ieEmit, ''))).toEqual([]);
  });

  it('vNFTot accepts 0.00 (TDec_1302, no longer the non-zero Opc type)', async () => {
    const xml = notaRtc();
    const vNFTot = /<vNFTot>[^<]+<\/vNFTot>/.exec(xml)![0];
    expect(await errosXsd(trocar(xml, vNFTot, '<vNFTot>0.00</vNFTot>'))).toEqual([]);
  });

  it('the IS per-unit rate is adRemIS now — pISEspec is refused', async () => {
    // Structural: an IS group with the pre-PL_010f element name must fail.
    const xml = notaRtc();
    const comIS = trocar(
      xml,
      '<IBSCBS>',
      '<IS><CSTIS>000</CSTIS><cClassTribIS>000001</cClassTribIS><vBCIS>1500.00</vBCIS>' +
        '<pIS>0.0000</pIS><adRemIS>1.0000</adRemIS><uTrib>UN</uTrib><qTrib>1.0000</qTrib>' +
        '<vIS>1.00</vIS></IS><IBSCBS>',
    );
    expect(await errosXsd(comIS)).toEqual([]);
    expect(await errosXsd(comIS.replace(/adRemIS>/g, 'pISEspec>'))).not.toEqual([]);
  });
});
