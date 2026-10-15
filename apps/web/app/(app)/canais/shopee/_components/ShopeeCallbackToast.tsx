'use client';

import { useShopeeCallbackToast } from './shopeeOAuthErrors';

/**
 * Renders nothing; exists only to run the callback toast on the channel LIST.
 *
 * The OAuth callback redirects here — not to the account page — whenever it
 * fails before recovering a trustworthy integração id (`config`, `bad_state`).
 * Without this component both would fail in complete silence: the browser simply
 * lands back on the list.
 *
 * ⚠️ Mount it inside a `<Suspense>`. The hook calls `useSearchParams`, which
 * Next requires to sit behind a boundary; isolating it in a null-rendering
 * component keeps that boundary from wrapping the table.
 */
export function ShopeeCallbackToast() {
  useShopeeCallbackToast();
  return null;
}
