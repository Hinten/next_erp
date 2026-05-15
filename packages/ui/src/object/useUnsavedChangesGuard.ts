'use client';

import { useEffect } from 'react';

/**
 * Warn the user before they leave a dirty form, covering three navigation
 * surfaces:
 *
 *  (a) `beforeunload` — closing the tab / refreshing / typing a new URL.
 *  (b) Clicks on internal `<a>` links (sidebar, in-app `<Link>`). The Next
 *      App Router exposes no route-change hook, so we intercept at the
 *      document level in the capture phase, before next/link handles it.
 *  (c) Back/forward (`popstate`). A sentinel history entry (same URL) is
 *      pushed; on `popstate` we confirm and either re-push the sentinel to
 *      stay or `history.back()` for real.
 *
 * All three use the synchronous `window.confirm` — interception of clicks
 * and `popstate` must decide on the spot, and it stays consistent with the
 * native `beforeunload` prompt.
 */
export function useUnsavedChangesGuard(
  isDirty: boolean,
  message = 'Há alterações não salvas. Deseja sair sem salvar?',
) {
  useEffect(() => {
    if (!isDirty) return;

    // (a) Hard navigation — close tab / refresh.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Setting `returnValue` is the cross-browser way to trigger the
      // native prompt. Modern browsers ignore the custom string.
      e.returnValue = message;
      return message;
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    // (b) Internal link clicks. Capture phase so this runs before
    // next/link's own handler.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#') || anchor.target === '_blank') return;
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same route (only hash/identical) — not a real navigation.
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      ) {
        return;
      }
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('click', onClick, true);

    // (c) Back/forward. Push a sentinel entry with the SAME URL; hitting
    // Back lands on it (no visible change) and fires `popstate`. Confirm
    // ⇒ history.back() for real; cancel ⇒ re-push the sentinel to stay.
    history.pushState(null, '', window.location.href);
    const onPopState = () => {
      if (window.confirm(message)) {
        window.removeEventListener('popstate', onPopState);
        history.back();
      } else {
        history.pushState(null, '', window.location.href);
      }
    };
    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState);
      // The sentinel entry stays in history — a harmless extra step with
      // the same URL. Cleaning it up here would race with a real
      // navigation in progress, so we leave it.
    };
  }, [isDirty, message]);
}
