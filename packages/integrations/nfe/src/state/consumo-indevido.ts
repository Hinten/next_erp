/**
 * Consumo Indevido Shield — fail fast and loud on SEFAZ cStat=656.
 *
 * SEFAZ enforces a per-(CNPJ, IP) "consumo indevido" throttle that
 * fires when a caller hammers any web service. Once triggered, the
 * throttle window lasts ~1h and every subsequent emission rejects
 * with cStat=656 too — so continuing a test run after a single 656
 * just deepens the backoff hole. The shield turns the FIRST 656 into
 * a typed exception with a CI-detectable marker so the live job
 * fails immediately and the operator knows to back off before
 * re-running.
 *
 * Design contract:
 *   - The error message ALWAYS starts with `[CONSUMO_INDEVIDO_SHIELD]`.
 *     CI scripts grep for this marker in the run logs to post the
 *     "wait ~1h before retrying" comment on the PR.
 *   - The helper is cheap and idempotent — safe to call after every
 *     SEFAZ response without conditional gating at the call site.
 *   - Composes on top of the existing `classifyCStat` mapping
 *     (`./index.ts:84`); does NOT duplicate the cStat → category
 *     classification.
 */

/** Marker prefix the CI report step greps for. Treat as a literal contract. */
export const CONSUMO_INDEVIDO_MARKER = '[CONSUMO_INDEVIDO_SHIELD]';

/**
 * Thrown when a SEFAZ response surfaces cStat=656 ("Consumo Indevido").
 * Distinct class so test boundaries can `instanceof` against it.
 */
export class NFeConsumoIndevidoError extends Error {
  readonly cStat: string;
  readonly xMotivo: string;
  readonly source: string;

  constructor(params: { cStat: string; xMotivo: string; source: string }) {
    super(
      `${CONSUMO_INDEVIDO_MARKER} SEFAZ cStat=${params.cStat} at ${params.source}: ${params.xMotivo}`,
    );
    this.name = 'NFeConsumoIndevidoError';
    this.cStat = params.cStat;
    this.xMotivo = params.xMotivo;
    this.source = params.source;
  }
}

/**
 * Throw an `NFeConsumoIndevidoError` if the SEFAZ response carries
 * cStat=656. Returns silently for every other cStat (including
 * paralisado / duplicidade / rejection — those have their own
 * handling paths). The `source` argument is free-text — pass the
 * test name or the SEFAZ operation name so the error message
 * names the offending call.
 */
export function assertNotConsumoIndevido(
  outcome: { readonly cStat: string; readonly xMotivo: string },
  source: string,
): void {
  if (outcome.cStat === '656') {
    throw new NFeConsumoIndevidoError({
      cStat: outcome.cStat,
      xMotivo: outcome.xMotivo,
      source,
    });
  }
}
