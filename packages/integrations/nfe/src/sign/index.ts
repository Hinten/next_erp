/**
 * XML digital signature for NF-e (XMLDSig, enveloped form).
 *
 * SEFAZ requires this exact algorithm set, in this exact wire shape:
 *
 *   - CanonicalizationMethod: `...REC-xml-c14n-20010315` (inclusive C14N)
 *   - SignatureMethod:        `...xmldsig#rsa-sha1`
 *   - Transforms:             enveloped-signature, then C14N
 *   - DigestMethod:           `...xmldsig#sha1`
 *   - KeyInfo:                ONLY `<X509Certificate>` — no chain, no
 *                             `KeyValue`/`X509SubjectName`/etc.
 *
 * What gets signed is the **`<infNFe>`** element (Id="NFe<chave>"), and the
 * `<Signature>` lands as its immediate sibling inside `<NFe>`. The signed XML
 * **must not be re-serialized** — even a whitespace change breaks the digest.
 * See `.claude/skills/nfe/references/assinatura.md`.
 *
 * Server-only: the signer holds the private key.
 */
import { SignedXml } from 'xml-crypto';

import type { NFeCertificate } from '../cert';

const C14N_URI = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const RSA_SHA1_URI = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
const ENVELOPED_URI = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const SHA1_URI = 'http://www.w3.org/2000/09/xmldsig#sha1';

export class NFeSignatureError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'NFeSignatureError';
  }
}

/**
 * Sign an `<NFe>` document. The input XML must contain a single `<infNFe>`
 * with an `Id` attribute (the conventional `NFe<chave>` value).
 *
 * Returns the signed `<NFe>` document as a string. Treat it as opaque bytes
 * after this point — re-parsing/re-serializing will break the digest.
 */
export function signNFe(xml: string, cert: NFeCertificate): string {
  return signWithReference(xml, cert, "//*[local-name(.)='infNFe']");
}

/**
 * Sign an `<infEvento>` document (cancelamento, CCe, manifestação).
 *
 * Same algorithm set as NF-e; only the reference XPath and the surrounding
 * element name differ. Kept here so Phase B / C reuse the algorithm wiring
 * instead of duplicating it.
 */
export function signEvento(xml: string, cert: NFeCertificate): string {
  return signWithReference(xml, cert, "//*[local-name(.)='infEvento']");
}

/**
 * Sign an `<infInut>` document (inutilização de numeração).
 */
export function signInutilizacao(xml: string, cert: NFeCertificate): string {
  return signWithReference(xml, cert, "//*[local-name(.)='infInut']");
}

function signWithReference(xml: string, cert: NFeCertificate, referenceXPath: string): string {
  const sig = new SignedXml({
    privateKey: cert.privateKeyPem,
    publicCert: cert.certificatePem,
    signatureAlgorithm: RSA_SHA1_URI,
    canonicalizationAlgorithm: C14N_URI,
  });
  // EndCertOnly: only <X509Certificate>, no KeyValue / X509SubjectName / etc.
  sig.getKeyInfoContent = ({ publicCert }) => {
    const pem = typeof publicCert === 'string' ? publicCert : publicCert?.toString('utf8') ?? '';
    const der = pem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s+/g, '');
    return `<X509Data><X509Certificate>${der}</X509Certificate></X509Data>`;
  };

  sig.addReference({
    xpath: referenceXPath,
    transforms: [ENVELOPED_URI, C14N_URI],
    digestAlgorithm: SHA1_URI,
  });

  try {
    sig.computeSignature(xml, {
      location: { reference: referenceXPath, action: 'after' },
    });
  } catch (err) {
    if (err instanceof Error) {
      throw new NFeSignatureError(`computeSignature failed: ${err.message}`, err);
    }
    throw err;
  }
  return sig.getSignedXml();
}
