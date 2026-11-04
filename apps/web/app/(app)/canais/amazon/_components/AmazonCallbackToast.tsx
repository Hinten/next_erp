'use client';

import { useOAuthCallbackToast } from '@/lib/oauth/useOAuthCallbackToast';
import { AMAZON_CALLBACK_TOAST } from './amazonOAuthErrors';

/**
 * Renders nothing; exists only to run the OAuth callback toast on the conta
 * LIST (`/canais/amazon`).
 *
 * The callback redirects here — not to the conta page — whenever it fails
 * before recovering a trustworthy conta id (`config`, `bad_state`). Without
 * this component both would fail in complete silence: the browser simply lands
 * back on the list. The conta page needs no copy of it: `ConnectionPanel` runs
 * the same hook with the same constant.
 *
 * ⚠️ Mount it inside a `<Suspense>`. The hook calls `useSearchParams`, and
 * `/canais/amazon` is a STATIC route, so without a boundary the production build
 * refuses to prerender it (`ConnectionPanel`'s mounting trap 1). Isolating the
 * hook in a null-rendering component keeps that boundary from wrapping the table.
 */
export function AmazonCallbackToast() {
  useOAuthCallbackToast(AMAZON_CALLBACK_TOAST);
  return null;
}
