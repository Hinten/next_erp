import { describe, it, expect } from 'vitest';
import forge from 'node-forge';

import { NFeXsdValidationError, supportedRoots, validateXsd } from '../../src/xsd/index';
import type { NFeCertificate } from '../../src/cert';
import {
  buildCancelamentoEvento,
  buildCCeDetEvento,
  buildEnvEvento,
} from '../../src/eventos/index';
import { buildInutNFe } from '../../src/inutilizacao/index';
import { signEvento, signInutilizacao } from '../../src/sign/index';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const CHAVE = '35200714200166000187550010000000071000000018';

/** Self-signed RSA key + cert so the XSD signature requirement is satisfied. */
function fixtureCertificate(): NFeCertificate {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'TEST SIGNER' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem: forge.pki.certificateToPem(cert),
    certificateDerBase64: forge.util.encode64(
      forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(),
    ),
    subjectCommonName: 'TEST SIGNER:99999999000191',
    cnpj: '99999999000191',
    notAfter: cert.validity.notAfter,
    pfxBuffer: Buffer.from(''),
    password: '',
  };
}

describe('supportedRoots', () => {
  it('covers every SEFAZ root Phase A talks to', () => {
    const roots = supportedRoots();
    expect(roots).toEqual(
      expect.arrayContaining([
        'enviNFe',
        'consReciNFe',
        'consSitNFe',
        'consStatServ',
        'inutNFe',
        'envEvento',
        'detEvento',
        'detEventoCCe',
        'NFe',
        'retEnviNFe',
        'retConsReciNFe',
        'retConsSitNFe',
        'retConsStatServ',
        'retInutNFe',
        'retEnvEvento',
        'procEventoNFe',
      ]),
    );
  });
});

describe('validateXsd — consStatServ', () => {
  it('accepts a valid consStatServ payload', async () => {
    const xml =
      `<consStatServ xmlns="${NFE_NS}" versao="4.00">` +
      `<tpAmb>2</tpAmb><cUF>35</cUF><xServ>STATUS</xServ>` +
      `</consStatServ>`;
    await expect(validateXsd('consStatServ', xml)).resolves.toBeUndefined();
  });

  it('rejects a tpAmb outside the {1,2} enum', async () => {
    const xml =
      `<consStatServ xmlns="${NFE_NS}" versao="4.00">` +
      `<tpAmb>9</tpAmb><cUF>35</cUF><xServ>STATUS</xServ>` +
      `</consStatServ>`;
    await expect(validateXsd('consStatServ', xml)).rejects.toBeInstanceOf(NFeXsdValidationError);
  });

  it('rejects a missing required field (cUF)', async () => {
    const xml =
      `<consStatServ xmlns="${NFE_NS}" versao="4.00">` +
      `<tpAmb>2</tpAmb><xServ>STATUS</xServ>` +
      `</consStatServ>`;
    await expect(validateXsd('consStatServ', xml)).rejects.toBeInstanceOf(NFeXsdValidationError);
  });

  it('rejects a wrong-namespace document', async () => {
    const xml =
      `<consStatServ xmlns="http://wrong/namespace" versao="4.00">` +
      `<tpAmb>2</tpAmb><cUF>35</cUF><xServ>STATUS</xServ>` +
      `</consStatServ>`;
    await expect(validateXsd('consStatServ', xml)).rejects.toBeInstanceOf(NFeXsdValidationError);
  });
});

describe('validateXsd — consSitNFe', () => {
  it('accepts a valid consSitNFe payload', async () => {
    const xml =
      `<consSitNFe xmlns="${NFE_NS}" versao="4.00">` +
      `<tpAmb>2</tpAmb><xServ>CONSULTAR</xServ>` +
      `<chNFe>35200714200166000187550010000000071000000017</chNFe>` +
      `</consSitNFe>`;
    await expect(validateXsd('consSitNFe', xml)).resolves.toBeUndefined();
  });

  it('rejects a chNFe of wrong length (43 instead of 44)', async () => {
    const xml =
      `<consSitNFe xmlns="${NFE_NS}" versao="4.00">` +
      `<tpAmb>2</tpAmb><xServ>CONSULTAR</xServ>` +
      `<chNFe>3520071420016600018755001000000007100000001</chNFe>` +
      `</consSitNFe>`;
    await expect(validateXsd('consSitNFe', xml)).rejects.toBeInstanceOf(NFeXsdValidationError);
  });
});

describe('validateXsd — envEvento (cancelamento, signed)', () => {
  const cert = fixtureCertificate();

  function signedEnvEvento(overrides?: { chNFe?: string }): string {
    const evento = buildCancelamentoEvento({
      chNFe: overrides?.chNFe ?? CHAVE,
      cOrgao: '35',
      cnpj: '14200166000187',
      nProt: '135200000012345',
      xJust: 'Cancelamento por erro de digitacao no pedido',
      tpAmb: '2',
      dhEvento: new Date('2026-05-29T10:00:00'),
    });
    return buildEnvEvento(signEvento(evento, cert));
  }

  // The strongest offline gate: the hand-built <evento>, the real signer,
  // and the SEFAZ XSD must all agree — without ever touching SEFAZ.
  it('accepts a built + signed envEvento', async () => {
    await expect(validateXsd('envEvento', signedEnvEvento())).resolves.toBeUndefined();
  });

  it('rejects an unsigned envEvento (Signature is required)', async () => {
    const unsigned = buildEnvEvento(
      buildCancelamentoEvento({
        chNFe: CHAVE,
        cOrgao: '35',
        cnpj: '14200166000187',
        nProt: '135200000012345',
        xJust: 'Cancelamento por erro de digitacao no pedido',
        tpAmb: '2',
      }),
    );
    await expect(validateXsd('envEvento', unsigned)).rejects.toBeInstanceOf(NFeXsdValidationError);
  });

  it('rejects a chNFe of the wrong length', async () => {
    // Corrupt the chNFe value after signing — XSD validation is structural
    // (it checks the 44-digit pattern, not the digest).
    const bad = signedEnvEvento().replace(
      `<chNFe>${CHAVE}</chNFe>`,
      `<chNFe>${CHAVE.slice(0, 43)}</chNFe>`,
    );
    await expect(validateXsd('envEvento', bad)).rejects.toBeInstanceOf(NFeXsdValidationError);
  });
});

describe('validateXsd — inutNFe (signed)', () => {
  const cert = fixtureCertificate();

  it('accepts a built + signed inutNFe', async () => {
    const signed = signInutilizacao(
      buildInutNFe({
        cUF: '35',
        ano: '26',
        cnpj: '14200166000187',
        serie: 9,
        nNFIni: 5,
        nNFFin: 12,
        xJust: 'Inutilizacao de faixa nao utilizada teste',
        tpAmb: '2',
      }),
      cert,
    );
    await expect(validateXsd('inutNFe', signed)).resolves.toBeUndefined();
  });
});

describe('validateXsd — detEvento (e110111 cancelamento payload)', () => {
  // detEvento carries the NFe namespace on the wire (inherited from <evento>);
  // e110111 is elementFormDefault=qualified, so the fragment needs it to
  // validate standalone.
  function detEvento(opts?: { omitXJust?: boolean }): string {
    return (
      `<detEvento xmlns="${NFE_NS}" versao="1.00">` +
      `<descEvento>Cancelamento</descEvento>` +
      `<nProt>135200000012345</nProt>` +
      (opts?.omitXJust ? '' : `<xJust>Cancelamento por erro de digitacao no pedido</xJust>`) +
      `</detEvento>`
    );
  }

  it('accepts a well-formed cancelamento detEvento', async () => {
    await expect(validateXsd('detEvento', detEvento())).resolves.toBeUndefined();
  });

  it('rejects a detEvento missing the required xJust', async () => {
    await expect(validateXsd('detEvento', detEvento({ omitXJust: true }))).rejects.toBeInstanceOf(
      NFeXsdValidationError,
    );
  });
});

describe('validateXsd — detEventoCCe (e110110 carta de correção payload)', () => {
  // buildCCeDetEvento emits the bare fragment; add the NFe namespace it inherits
  // from <evento> on the wire so the standalone fragment validates (e110110 is
  // elementFormDefault=qualified) — same shape the operation layer sends.
  const withNs = (det: string): string => det.replace('<detEvento', `<detEvento xmlns="${NFE_NS}"`);

  it('accepts a well-formed CC-e detEvento (fixed xCondUso + valid xCorrecao)', async () => {
    const det = withNs(
      buildCCeDetEvento({ xCorrecao: 'Correcao do peso bruto informado no transporte' }),
    );
    await expect(validateXsd('detEventoCCe', det)).resolves.toBeUndefined();
  });

  it('rejects a CC-e detEvento whose xCorrecao is below 15 chars', async () => {
    const det = withNs(buildCCeDetEvento({ xCorrecao: 'curto' }));
    await expect(validateXsd('detEventoCCe', det)).rejects.toBeInstanceOf(NFeXsdValidationError);
  });
});

describe('validateXsd — event/inut responses', () => {
  it('accepts a valid retEnvEvento', async () => {
    const xml =
      `<retEnvEvento xmlns="${NFE_NS}" versao="1.00">` +
      `<idLote>1</idLote><tpAmb>2</tpAmb><verAplic>SP_EVENTOS</verAplic>` +
      `<cOrgao>35</cOrgao><cStat>128</cStat>` +
      `<xMotivo>Lote de Evento Processado</xMotivo>` +
      // The response infEvento Id pattern is ID[0-9]{15} (optional) — distinct
      // from the request's ID+tpEvento+chave+nSeq. Omit it (SEFAZ may too).
      `<retEvento versao="1.00"><infEvento>` +
      `<tpAmb>2</tpAmb><verAplic>SP_EVENTOS</verAplic><cOrgao>35</cOrgao>` +
      `<cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo>` +
      `<chNFe>${CHAVE}</chNFe><tpEvento>110111</tpEvento>` +
      `<xEvento>Cancelamento</xEvento><nSeqEvento>1</nSeqEvento>` +
      `<dhRegEvento>2026-05-29T10:00:00-03:00</dhRegEvento>` +
      `<nProt>135200000099999</nProt>` +
      `</infEvento></retEvento></retEnvEvento>`;
    await expect(validateXsd('retEnvEvento', xml)).resolves.toBeUndefined();
  });

  it('accepts a valid retInutNFe', async () => {
    const xml =
      `<retInutNFe xmlns="${NFE_NS}" versao="4.00">` +
      `<infInut Id="ID35261420016600018755009000000005000000012">` +
      `<tpAmb>2</tpAmb><verAplic>SP_NFE</verAplic><cStat>102</cStat>` +
      `<xMotivo>Inutilizacao de numero homologada</xMotivo>` +
      `<cUF>35</cUF><ano>26</ano><CNPJ>14200166000187</CNPJ><mod>55</mod>` +
      `<serie>9</serie><nNFIni>5</nNFIni><nNFFin>12</nNFFin>` +
      `<dhRecbto>2026-05-29T10:00:00-03:00</dhRecbto>` +
      `<nProt>135200000088888</nProt>` +
      `</infInut></retInutNFe>`;
    await expect(validateXsd('retInutNFe', xml)).resolves.toBeUndefined();
  });
});

describe('NFeXsdValidationError', () => {
  it('carries the rootKey and the error list', async () => {
    const badXml = `<consStatServ xmlns="${NFE_NS}" versao="4.00"><tpAmb>9</tpAmb><cUF>35</cUF><xServ>STATUS</xServ></consStatServ>`;
    try {
      await validateXsd('consStatServ', badXml);
      throw new Error('expected validateXsd to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NFeXsdValidationError);
      const e = err as NFeXsdValidationError;
      expect(e.rootKey).toBe('consStatServ');
      expect(e.errors.length).toBeGreaterThan(0);
      expect(e.errors[0]?.message).toBeTruthy();
    }
  });
});
