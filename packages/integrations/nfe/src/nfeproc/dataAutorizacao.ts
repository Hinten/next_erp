/**
 * `<nfeProc>` → the instant SEFAZ authorized the NF-e, in MILLISECONDS since
 * the epoch: the `nfev4.data_autorizacao` the approval write stamps (#1743).
 *
 * The source is `protNFe/infProt/dhRecbto`, the authorizer's own receipt time
 * with its own offset. The legacy Flutter app stamped the field from exactly
 * that value, in the same write that persisted `xml_nfe_proc`
 * (`.old/packages/pedido_nfe/lib/src/tasks.dart:1522-1535`), so the migrated
 * corpus and the notes this app authorizes mean the same instant.
 *
 * Regex rather than a DOM, for the reason `src/totals/index.ts` gives: one
 * flat scalar inside one element. `parseProcNFe` (`src/danfe/model.ts`) also
 * reads `dhRecbto`, but it runs a full xmldom parse of the whole proc and returns
 * the raw string, which is what the DANFE prints. It never computes an instant.
 *
 * ⚠️ **An offset is required, never assumed.** `TDateTimeUTC` always carries one,
 * and `parseIsoToMillis` resolves an offset-less string as UTC, three hours away
 * from the Brasília instant SEFAZ meant. A value that cannot be read as an
 * absolute instant is `null`. The caller then writes nothing, and the stored
 * value (or the `null` the doc was created with) stays.
 */
import { parseIsoToMillis, type MillisSinceEpoch } from '@delfrance/core/datetime';

/** `<infProt>…</infProt>`, tolerating a namespace prefix and attributes (`Id`). */
const INF_PROT_RE = /<(?:[\w.-]+:)?infProt(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?infProt>/;
/** `<dhRecbto>…</dhRecbto>`, read only inside the `<infProt>` slice. */
const DH_RECBTO_RE = /<(?:[\w.-]+:)?dhRecbto(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?dhRecbto>/;
/** An absolute instant: `Z` or the XSD's `±hh:mm` at the end. */
const OFFSET_EXPLICITO_RE = /(?:[Zz]|[+-]\d{2}:\d{2})$/;

/**
 * The authorization instant of an `<nfeProc>`, or `null` when its `<infProt>`
 * carries no `dhRecbto` that reads as an absolute instant.
 *
 * Scoped to `<infProt>` first, so a `dhRecbto` anywhere else in the document is
 * never taken for the protocol's.
 */
export function extrairDataAutorizacao(procXml: string): MillisSinceEpoch | null {
  const infProt = INF_PROT_RE.exec(procXml)?.[1];
  if (infProt == null) return null;
  const dhRecbto = DH_RECBTO_RE.exec(infProt)?.[1]?.trim();
  if (dhRecbto == null || !OFFSET_EXPLICITO_RE.test(dhRecbto)) return null;
  return parseIsoToMillis(dhRecbto);
}
