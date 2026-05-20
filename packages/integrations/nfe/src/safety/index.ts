/**
 * Production-safety guard.
 *
 * The default is **homologação only**: any call that asks SEFAZ to act on
 * `tpAmb='1'` (produção) is rejected unless the caller has explicitly
 * opted in via `NFE_ALLOW_PRODUCAO=true`. This makes accidental production
 * traffic from a dev machine, a forgotten CI job, or a test harness
 * impossible without a deliberate change to the environment.
 *
 * Vitest is allowed through automatically (it sets `NODE_ENV='test'`), so
 * the existing generator tests that exercise the produção branch keep
 * working without ceremony.
 */

export class NFeProductionGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeProductionGuardError';
  }
}

/** SEFAZ `tpAmb` literal — `'1'` produção, `'2'` homologação. */
export type TpAmb = '1' | '2';

/**
 * Reject a `tpAmb='1'` (produção) call unless either:
 *   - `process.env.NFE_ALLOW_PRODUCAO === 'true'` (explicit opt-in), or
 *   - `process.env.NODE_ENV === 'test'` (Vitest sets this).
 *
 * `tpAmb='2'` (homologação) always passes through without checks.
 *
 * Call this at every boundary that ultimately produces SEFAZ traffic:
 *   - The NF-e generator, before any work.
 *   - Every SOAP operation, immediately before the HTTPS POST.
 */
export function assertSafeTpAmb(tpAmb: TpAmb): void {
  if (tpAmb === '2') return;
  if (process.env.NFE_ALLOW_PRODUCAO === 'true') return;
  if (process.env.NODE_ENV === 'test') return;
  throw new NFeProductionGuardError(
    "tpAmb='1' (produção) requires NFE_ALLOW_PRODUCAO=true. " +
      "Use tpAmb='2' (homologação) for non-production work.",
  );
}

/** Map a generator `ambiente` value to the SEFAZ `tpAmb` literal. */
export function tpAmbFromAmbiente(ambiente: 'producao' | 'homologacao'): TpAmb {
  return ambiente === 'producao' ? '1' : '2';
}
