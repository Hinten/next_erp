'use client';

import { useMelhorEnvioCallbackToast } from './melhorEnvioOAuthErrors';

/**
 * Renders nothing; exists only to run the callback toast on the Melhor Envio LIST.
 *
 * The OAuth callback redirects here — not to the account page — whenever it fails
 * before recovering a trustworthy `int_frete` id (`config`, `missing_params`,
 * `bad_state`). That page had no `me`/`reason` handling, so all three failed in
 * complete silence: the browser simply landed back on the list.
 *
 * ⚠️ Mount it in the thin `melhor-envios/page.tsx` wrapper, NOT inside
 * `IntFreteListPage` — that component is shared with fob / motoboy / retirada, none
 * of which has an OAuth flow.
 *
 * ⚠️ Mount it inside a `<Suspense>`. The hook calls `useSearchParams`, which Next
 * requires to sit behind a boundary; isolating it in a null-rendering component
 * keeps that boundary from wrapping the table.
 */
export function MelhorEnvioCallbackToast() {
  useMelhorEnvioCallbackToast();
  return null;
}
