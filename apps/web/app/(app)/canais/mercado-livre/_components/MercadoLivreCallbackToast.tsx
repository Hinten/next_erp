'use client';

import { useMercadoLivreCallbackToast } from './mercadoLivreOAuthErrors';

/**
 * Renders nothing; exists only to run the callback toast on the channel LIST.
 *
 * The OAuth callback redirects here — not to the account page — whenever it fails
 * before recovering a trustworthy integração id (`config`, `missing_params`,
 * `bad_state`). This page had no `ml`/`reason` handling, so all three failed in
 * complete silence: the browser simply landed back on the list.
 *
 * ⚠️ Mount it inside a `<Suspense>`. The hook calls `useSearchParams`, which Next
 * requires to sit behind a boundary; isolating it in a null-rendering component
 * keeps that boundary from wrapping the table. Same shape as `ChatInboxShell`.
 */
export function MercadoLivreCallbackToast() {
  useMercadoLivreCallbackToast();
  return null;
}
