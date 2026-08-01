/**
 * #128 invariant — the signed XML is never lost. Called at the fake
 * Firestore's write boundary (orchestrator / batch / pendentes suites) so
 * EVERY test that writes an nfev4 doc polices it, current and future:
 *
 *  - a merge-write may set `xml_assinado: null` ONLY while persisting a
 *    non-empty `xml_nfe_proc` in the very same payload (the nfeProc embeds
 *    the signed NFe — `swapAnchorForProc` is the only legal producer);
 *  - no write may carry a FieldValue-style sentinel for an XML field —
 *    deletion would make the field absent, which the nfev4 schema forbids
 *    (`.nullable()` without `.optional()`).
 *
 * Full-doc (non-merge) writes may set `xml_assinado: null` freely: the
 * numeração-anchoring placeholder is created that way before the signed
 * XML exists, so there is nothing to lose yet.
 */
export function assertSignedXmlNeverLost(
  path: string,
  data: Record<string, unknown>,
  merge: boolean | undefined,
): void {
  if (!path.includes('/nfev4/')) return;
  for (const field of ['xml_assinado', 'xml_nfe_proc', 'xml_epec_proc'] as const) {
    if (field in data && data[field] != null && typeof data[field] !== 'string') {
      throw new Error(
        `#128 invariant: write on ${path} sets ${field} to a non-string value — ` +
          'FieldValue sentinels are forbidden for XML fields (the schema requires presence).',
      );
    }
  }
  if (merge === true && 'xml_assinado' in data && data.xml_assinado === null) {
    const proc = data.xml_nfe_proc;
    if (typeof proc !== 'string' || proc.length === 0) {
      throw new Error(
        `#128 invariant violated: merge-write on ${path} clears xml_assinado without ` +
          'persisting a non-empty xml_nfe_proc in the same payload — the signed XML would be lost.',
      );
    }
  }
}
