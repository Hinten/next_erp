/**
 * `<nfeProc>` envelope builder — the SEFAZ-authorized form of an NF-e.
 *
 * Post-emission stitching: combines the locally-signed `<NFe>` with the
 * `<protNFe>` SEFAZ returns on cStat=100/150 (autorizada). The resulting
 * `<nfeProc>` is what DANFE renderers consume, what fiscal audits
 * require, and what gets sent to recipients / marketplaces /
 * accountants. The bare signed NFe alone is NOT a valid legal document —
 * it becomes one only when paired with the SEFAZ protocol that
 * authorized it.
 *
 * Mirrors Flutter `nfe_client/lib/src/schemas/procNFe.dart:31`
 * (`makeXmlNFeProc`). SEFAZ schema: `procNFe_v4.00.xsd`.
 */
import type { TProtNFe } from '../types/nfe-schema';
import { serializeFragment, type XmlValue } from '../xml';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';

/**
 * Build the canonical `<nfeProc>` envelope.
 *
 * `signedNfeXml` MUST be the exact signed `<NFe>…</NFe>` string —
 * `protNFe.infProt.digVal` was computed against that exact byte
 * sequence. Do NOT re-derive it from a parsed object; round-tripping
 * through serialize/parse would invalidate the signature.
 *
 * The function strips any leading `<?xml … ?>` declaration from
 * `signedNfeXml` (only the outer envelope keeps one) and embeds the
 * NFe verbatim. `serializeFragment` walks the META definitions for
 * `TProtNFe` to emit the protocol in canonical SEFAZ order; the inner
 * `protNFe` inherits the envelope's namespace, matching the wire
 * format SEFAZ ships.
 */
export function buildNFeProc(
  signedNfeXml: string,
  protNFe: TProtNFe,
  versao: '4.00' = '4.00',
): string {
  const protXml = serializeFragment(
    'TProtNFe',
    'protNFe',
    protNFe as unknown as XmlValue,
  );
  const nfeInner = stripXmlDeclaration(signedNfeXml).trim();
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<nfeProc xmlns="${NFE_NS}" versao="${versao}">${nfeInner}${protXml}</nfeProc>`
  );
}

function stripXmlDeclaration(xml: string): string {
  return xml.replace(/^\s*<\?xml[^?]*\?>\s*/, '');
}
