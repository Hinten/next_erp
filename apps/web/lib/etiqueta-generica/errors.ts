/**
 * Errors this label can raise. Kept in their own module so `index.ts` can
 * re-export them without either renderer having to import the other.
 *
 * ⚠️ These deliberately do NOT reuse `NFeDanfeFormatError` from the nfe
 * package, close as the cases are: `apps/web/eslint.config.mjs` forbids
 * importing that package's root (only `/http-provider` is allowed, since
 * everything else drags in server-only dependencies). The wording follows the
 * DANFE one so an operator who has seen one recognises the other.
 */

/**
 * The label cannot be produced in the requested format because of the shape of
 * its own data — not a transient failure, so there is nothing to retry.
 *
 * `genericLabelProvider` catches it like any `Error`, red-toasts the message
 * and returns `{ status: 'error' }`, so the message is what the operator reads:
 * name the offending value and the way out.
 */
export class EtiquetaGenericaFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EtiquetaGenericaFormatError';
  }
}
