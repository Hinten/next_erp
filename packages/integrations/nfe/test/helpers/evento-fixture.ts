/**
 * A `retConsSitNFe` (consSitNFe reply) carrying SEFAZ's copies of the NF-e's
 * events, for the event read-back tests (#1094 F1b).
 *
 * CONSTRUCTED, not captured: no homologação reply with several CC-es has been
 * recorded, and recording one costs real SEFAZ calls. It is built from the same
 * pieces a real reply holds — our own `buildCCeEvento` / `buildCancelamentoEvento`,
 * signed by the real signer over a throwaway self-signed key, plus a hand-built
 * `retEvento` in the leiaute's element order — and `test/eventos/extrair.test.ts`
 * asserts the whole document passes the SEFAZ `retConsSitNFe` XSD, so the shape
 * cannot drift from the schema unnoticed.
 */
import forge from 'node-forge';

import type { NFeCertificate } from '../../src/cert';
import {
  buildCancelamentoEvento,
  buildCCeEvento,
  TP_EVENTO_CANCELAMENTO,
  TP_EVENTO_CCE,
} from '../../src/eventos/index';
import { signEvento } from '../../src/sign/index';

export const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
export const CHAVE = '35200714200166000187550010000000071000000018';
const CNPJ = '14200166000187';

let certificado: NFeCertificate | undefined;

/** Self-signed RSA key + cert — satisfies the XSD's required `<Signature>`, never SEFAZ. */
export function certificadoDeTeste(): NFeCertificate {
  if (certificado) return certificado;
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
  certificado = {
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem: forge.pki.certificateToPem(cert),
    certificateDerBase64: forge.util.encode64(
      forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(),
    ),
    subjectCommonName: `TEST SIGNER:${CNPJ}`,
    cnpj: CNPJ,
    notAfter: cert.validity.notAfter,
    pfxBuffer: Buffer.from(''),
    password: '',
  };
  return certificado;
}

export interface EventoDaFixture {
  readonly tipo: 'cce' | 'cancelamento';
  readonly nSeqEvento: number;
  /** CC-e text as it should appear in `<xCorrecao>` — ALREADY escaped XML text. */
  readonly xCorrecaoXml?: string;
  readonly cStat: string;
  readonly xMotivo: string;
  readonly nProt?: string;
  readonly dhRegEvento: string;
}

/** Our signed `<evento>` for one fixture event. */
export function eventoAssinado(e: EventoDaFixture): string {
  const dhEvento = new Date('2026-09-20T10:00:00-03:00');
  if (e.tipo === 'cancelamento') {
    return signEvento(
      buildCancelamentoEvento({
        chNFe: CHAVE,
        cOrgao: '35',
        cnpj: CNPJ,
        nProt: '135260000000001',
        xJust: 'Cancelamento por erro de digitacao no pedido',
        tpAmb: '2',
        dhEvento,
      }),
      certificadoDeTeste(),
    );
  }
  const PLACEHOLDER = 'TEXTO DA CORRECAO A SUBSTITUIR ANTES DA ASSINATURA';
  const evento = buildCCeEvento({
    chNFe: CHAVE,
    cOrgao: '35',
    cnpj: CNPJ,
    xCorrecao: PLACEHOLDER,
    nSeqEvento: e.nSeqEvento,
    tpAmb: '2',
    dhEvento,
  });
  // The builder sanitizes (no `&`/`<`), but ANOTHER emitter's carta can carry
  // entities, so the text is swapped in as raw XML text before signing.
  return signEvento(
    evento.replace(PLACEHOLDER, e.xCorrecaoXml ?? 'Correcao do peso bruto informado'),
    certificadoDeTeste(),
  );
}

/** SEFAZ's `<retEvento>` for one fixture event, in the leiaute's element order. */
export function retEventoXml(e: EventoDaFixture): string {
  const tpEvento = e.tipo === 'cce' ? TP_EVENTO_CCE : TP_EVENTO_CANCELAMENTO;
  const xEvento = e.tipo === 'cce' ? 'Carta de Correcao registrada' : 'Cancelamento registrado';
  return (
    `<retEvento versao="1.00"><infEvento>` +
    `<tpAmb>2</tpAmb><verAplic>SP_EVENTOS_PL_100</verAplic><cOrgao>35</cOrgao>` +
    `<cStat>${e.cStat}</cStat><xMotivo>${e.xMotivo}</xMotivo><chNFe>${CHAVE}</chNFe>` +
    `<tpEvento>${tpEvento}</tpEvento><xEvento>${xEvento}</xEvento>` +
    `<nSeqEvento>${e.nSeqEvento}</nSeqEvento><dhRegEvento>${e.dhRegEvento}</dhRegEvento>` +
    (e.nProt ? `<nProt>${e.nProt}</nProt>` : '') +
    `</infEvento></retEvento>`
  );
}

/**
 * One `<procEventoNFe>` as it sits INSIDE the reply. `xmlns: false` is the
 * harder shape: neither `procEventoNFe` nor the signed `evento` declares the
 * namespace, which they inherit from the `retConsSitNFe` root. The signature
 * stays valid IN the reply — inclusive C14N renders the in-scope namespace on
 * `infEvento` either way — but a bare slice of it no longer verifies.
 */
export function procEventoNaResposta(e: EventoDaFixture, opts: { xmlns: boolean }): string {
  let evento = eventoAssinado(e).replace(/^<\?xml[^>]*\?>/, '');
  if (!opts.xmlns) evento = evento.replace(`<evento xmlns="${NFE_NS}"`, '<evento');
  const ns = opts.xmlns ? ` xmlns="${NFE_NS}"` : '';
  return `<procEventoNFe${ns} versao="1.00">${evento}${retEventoXml(e)}</procEventoNFe>`;
}

/** The whole `retConsSitNFe`: the NF-e's protocol, then its events in order. */
export function retConsSitNFe(procEventos: readonly string[]): string {
  return (
    `<retConsSitNFe xmlns="${NFE_NS}" versao="4.00">` +
    `<tpAmb>2</tpAmb><verAplic>SP_NFE_PL009_V4</verAplic><cStat>100</cStat>` +
    `<xMotivo>Autorizado o uso da NF-e</xMotivo><cUF>35</cUF>` +
    `<dhRecbto>2026-09-21T09:00:00-03:00</dhRecbto><chNFe>${CHAVE}</chNFe>` +
    `<protNFe versao="4.00"><infProt>` +
    `<tpAmb>2</tpAmb><verAplic>SP_NFE_PL009_V4</verAplic><chNFe>${CHAVE}</chNFe>` +
    `<dhRecbto>2026-09-20T09:00:00-03:00</dhRecbto><nProt>135260000000001</nProt>` +
    `<digVal>q2dWbCh6WDhVbzFPZ3hLcXZ0QjlzQ2pPVGs9</digVal>` +
    `<cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>` +
    `</infProt></protNFe>` +
    procEventos.join('') +
    `</retConsSitNFe>`
  );
}
