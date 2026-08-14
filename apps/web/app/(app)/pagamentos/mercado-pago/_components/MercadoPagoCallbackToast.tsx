'use client';

import { useMercadoPagoCallbackToast } from './mercadoPagoOAuthErrors';

/**
 * Renders nothing; exists only to run the callback toast on the payment-method LIST.
 *
 * The OAuth callback redirects here — not to the account page — whenever it fails
 * before recovering a trustworthy `metodo_pgto` id (`config`, `missing_params`,
 * `bad_state`).
 *
 * ⚠️ Mount it inside a `<Suspense>`. The hook calls `useSearchParams`, which Next
 * requires to sit behind a boundary; the page used to call it at its own top level,
 * so the whole table shared that constraint. Isolating it in a null-rendering
 * component keeps the boundary off the table.
 */
export function MercadoPagoCallbackToast() {
  useMercadoPagoCallbackToast();
  return null;
}
