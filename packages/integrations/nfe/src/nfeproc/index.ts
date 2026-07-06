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
  const protXml = serializeFragment('TProtNFe', 'protNFe', protNFe as unknown as XmlValue);
  const nfeInner = stripXmlDeclaration(signedNfeXml).trim();
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<nfeProc xmlns="${NFE_NS}" versao="${versao}">${nfeInner}${protXml}</nfeProc>`
  );
}

function stripXmlDeclaration(xml: string): string {
  return xml.replace(/^\s*<\?xml[^?]*\?>\s*/, '');
}

// ---------------------------------------------------------------------------
// Digest guard (#396) — never pair a protNFe with bytes it didn't authorize.
//
// `protNFe.infProt.digVal` is SEFAZ's copy of the signature DigestValue it
// authorized. If the local signed XML was regenerated after the original send
// (crash-window retry: same chave, fresh dhEmi → different bytes), stitching
// the ORIGINAL protocol onto the NEW bytes persists a legal document that
// fails digest verification. Callers gate `buildNFeProc` on
// `compareDigest(...) !== 'mismatch'`.
// ---------------------------------------------------------------------------

/** Result of comparing the local signed XML's DigestValue with SEFAZ's digVal. */
export type DigestComparison = 'match' | 'mismatch' | 'unknown';

const DIGEST_VALUE_RE =
  /<(?:[\w.-]+:)?DigestValue(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?DigestValue>/g;
const DIGVAL_OUTER_RE =
  /^\s*<(?:[\w.-]+:)?digVal(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?digVal>\s*$/;

/**
 * The single `<DigestValue>` of a signed `<NFe>`. Our signature has exactly
 * one Reference, so exactly one occurrence is expected — zero or multiple
 * (ambiguous) return `null`, which callers treat as 'unknown' (never blocks).
 */
export function extractDigestValue(signedXml: string): string | null {
  const matches = [...signedXml.matchAll(DIGEST_VALUE_RE)];
  if (matches.length !== 1) return null;
  const value = matches[0]![1]!.replace(/\s+/g, '');
  return value.length > 0 ? value : null;
}

/**
 * Normalize `TProtNFe_infProt.digVal` to bare base64. The codegen META marks
 * `digVal` as `#raw`, so a WIRE-parsed protNFe carries the OUTER XML
 * (`<digVal>base64</digVal>`), while fixtures / JSON-restored values carry the
 * bare string — accept both. Whitespace-stripped; empty → null.
 */
export function normalizeDigVal(digVal: string | null | undefined): string | null {
  if (digVal == null) return null;
  const unwrapped = DIGVAL_OUTER_RE.exec(digVal)?.[1] ?? digVal;
  const value = unwrapped.replace(/\s+/g, '');
  return value.length > 0 ? value : null;
}

/**
 * Tri-state digest comparison: `'mismatch'` ONLY when BOTH sides are present
 * and differ. An absent `digVal` (optional on the wire) or an unextractable
 * local DigestValue yields `'unknown'` — callers must not block on it, so the
 * normal same-round-trip path is never affected.
 */
export function compareDigest(
  signedXml: string,
  digVal: string | null | undefined,
): DigestComparison {
  const local = extractDigestValue(signedXml);
  const remote = normalizeDigVal(digVal);
  if (local == null || remote == null) return 'unknown';
  return local === remote ? 'match' : 'mismatch';
}
