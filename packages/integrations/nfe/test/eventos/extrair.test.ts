/**
 * `extrairEventosNFe` — reading SEFAZ's copies of an NF-e's events back out of
 * a `retConsSitNFe` (#1094 F1b). The fixture is constructed, so the first test
 * pins it against the SEFAZ XSD; the rest pin what a caller deciding fiscal
 * state from the answer relies on.
 */
import { describe, expect, it } from 'vitest';
import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';

import {
  extrairEventosNFe,
  NFeEventoError,
  TP_EVENTO_CANCELAMENTO,
  TP_EVENTO_CCE,
} from '../../src/eventos/index';
import { validateXsd } from '../../src/xsd/index';
import {
  certificadoDeTeste,
  NFE_NS,
  procEventoNaResposta,
  retConsSitNFe,
  type EventoDaFixture,
} from '../helpers/evento-fixture';

const CCE_1: EventoDaFixture = {
  tipo: 'cce',
  nSeqEvento: 1,
  xCorrecaoXml: 'Correcao do peso bruto informado no transporte',
  cStat: '135',
  xMotivo: 'Evento registrado e vinculado a NF-e',
  nProt: '135260000000011',
  dhRegEvento: '2026-09-20T10:00:05-03:00',
};
const CCE_2: EventoDaFixture = {
  tipo: 'cce',
  nSeqEvento: 2,
  // Another emitter's carta can carry entities; ours never does (sanitized).
  xCorrecaoXml: 'Peso &amp; volumes &lt;corrigidos&gt; conforme romaneio',
  cStat: '135',
  xMotivo: 'Evento registrado e vinculado a NF-e',
  nProt: '135260000000012',
  dhRegEvento: '2026-09-20T11:00:05-03:00',
};
const CANCELAMENTO: EventoDaFixture = {
  tipo: 'cancelamento',
  nSeqEvento: 1,
  cStat: '135',
  xMotivo: 'Evento registrado e vinculado a NF-e',
  nProt: '135260000000013',
  dhRegEvento: '2026-09-21T08:00:05-03:00',
};

const PROLOGO = '<?xml version="1.0" encoding="UTF-8"?>';

function assinaturaConfere(xml: string): boolean {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const sig = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0];
  if (!sig) throw new Error('no <Signature> in the document');
  const verifier = new SignedXml({ publicCert: certificadoDeTeste().certificatePem });
  verifier.loadSignature(sig.toString());
  return verifier.checkSignature(xml);
}

describe('extrairEventosNFe', () => {
  const procs = [CCE_1, CCE_2, CANCELAMENTO].map((e) => procEventoNaResposta(e, { xmlns: true }));
  const resposta = retConsSitNFe(procs);

  it('the constructed fixture is a schema-valid retConsSitNFe', async () => {
    await expect(validateXsd('retConsSitNFe', resposta)).resolves.toBeUndefined();
  });

  it('reads every event, in document order, with the fields a caller decides from', () => {
    const eventos = extrairEventosNFe(resposta);
    expect(eventos.map(({ procEventoXml: _, ...e }) => e)).toEqual([
      {
        tpEvento: TP_EVENTO_CCE,
        nSeqEvento: 1,
        cStat: '135',
        xMotivo: 'Evento registrado e vinculado a NF-e',
        nProt: '135260000000011',
        dhRegEvento: '2026-09-20T10:00:05-03:00',
        xCorrecao: 'Correcao do peso bruto informado no transporte',
      },
      {
        tpEvento: TP_EVENTO_CCE,
        nSeqEvento: 2,
        cStat: '135',
        xMotivo: 'Evento registrado e vinculado a NF-e',
        nProt: '135260000000012',
        dhRegEvento: '2026-09-20T11:00:05-03:00',
        // Unescaped exactly once: `&amp;` → `&`, never left escaped nor double-decoded.
        xCorrecao: 'Peso & volumes <corrigidos> conforme romaneio',
      },
      {
        tpEvento: TP_EVENTO_CANCELAMENTO,
        nSeqEvento: 1,
        cStat: '135',
        xMotivo: 'Evento registrado e vinculado a NF-e',
        nProt: '135260000000013',
        dhRegEvento: '2026-09-21T08:00:05-03:00',
        // Not a CC-e: no correction text, even though the event has a detEvento.
        xCorrecao: null,
      },
    ]);
  });

  it('filters by tpEvento', () => {
    expect(extrairEventosNFe(resposta, TP_EVENTO_CCE).map((e) => e.nSeqEvento)).toEqual([1, 2]);
    expect(extrairEventosNFe(resposta, TP_EVENTO_CANCELAMENTO).map((e) => e.tpEvento)).toEqual([
      TP_EVENTO_CANCELAMENTO,
    ]);
    expect(extrairEventosNFe(resposta, '110140')).toEqual([]);
  });

  it('a reply with no events gives [] — never a throw', () => {
    expect(extrairEventosNFe(retConsSitNFe([]))).toEqual([]);
  });

  it('an event SEFAZ did not register keeps a null nProt', () => {
    const rejeitado = { ...CCE_1, cStat: '573', xMotivo: 'Rejeicao: Duplicidade de evento' };
    delete (rejeitado as { nProt?: string }).nProt;
    const [evento] = extrairEventosNFe(
      retConsSitNFe([procEventoNaResposta(rejeitado, { xmlns: true })]),
    );
    expect(evento).toMatchObject({ cStat: '573', nProt: null, nSeqEvento: 1 });
  });

  describe('procEventoXml — SEFAZ bytes, standalone', () => {
    it('is the reply slice verbatim, behind the prolog, when the slice declares its namespace', () => {
      const [primeiro] = extrairEventosNFe(resposta);
      expect(primeiro!.procEventoXml).toBe(PROLOGO + procs[0]);
      expect(resposta).toContain(procs[0]);
    });

    it('verifies as a standalone schema-valid document', async () => {
      for (const { procEventoXml } of extrairEventosNFe(resposta)) {
        expect(assinaturaConfere(procEventoXml)).toBe(true);
        await expect(validateXsd('procEventoNFe', procEventoXml)).resolves.toBeUndefined();
      }
    });

    it('gets the namespace the reply only declared on its root — and still verifies', async () => {
      const semNs = procEventoNaResposta(CCE_1, { xmlns: false });
      const [evento] = extrairEventosNFe(retConsSitNFe([semNs]));
      const doc = evento!.procEventoXml;

      // Only the root start tag changes; everything after it is SEFAZ's bytes.
      expect(doc).toBe(
        `${PROLOGO}<procEventoNFe xmlns="${NFE_NS}"${semNs.slice('<procEventoNFe'.length)}`,
      );
      expect(assinaturaConfere(doc)).toBe(true);
      await expect(validateXsd('procEventoNFe', doc)).resolves.toBeUndefined();
      // Near-miss: the bare slice is NOT a verifiable document — the namespace
      // the signature was computed under is gone. This is why it is injected.
      expect(assinaturaConfere(PROLOGO + semNs)).toBe(false);
    });
  });

  describe('refuses to guess', () => {
    it('throws on a non-numeric nSeqEvento', () => {
      const ruim = resposta.replace('<nSeqEvento>1</nSeqEvento>', '<nSeqEvento>X</nSeqEvento>');
      expect(ruim).not.toBe(resposta);
      expect(() => extrairEventosNFe(ruim)).toThrow(NFeEventoError);
    });

    it('throws on an event without its retEvento', () => {
      const semRet = procs[0]!.replace(/<retEvento[\s\S]*<\/retEvento>/, '');
      expect(() => extrairEventosNFe(retConsSitNFe([semRet]))).toThrow(NFeEventoError);
    });

    it('throws on a prefixed procEventoNFe whose prefix is declared outside it', () => {
      const prefixado =
        `<n:retConsSitNFe xmlns:n="${NFE_NS}" versao="4.00">` +
        `<n:procEventoNFe versao="1.00"><n:evento/></n:procEventoNFe></n:retConsSitNFe>`;
      expect(() => extrairEventosNFe(prefixado)).toThrow(/prefixo 'n'/);
    });
  });
});
