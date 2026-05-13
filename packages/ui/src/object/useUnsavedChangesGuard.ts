'use client';

import { useEffect } from 'react';

/**
 * Block tab close / refresh when the form is dirty.
 *
 * Heads up: the Next.js App Router intentionally does not expose a route
 * change hook (no equivalent to the old Pages-Router `routeChangeStart`).
 * Intercepting internal navigation requires patching `history.pushState` /
 * `popstate`, which has edge cases (modals, parallel routes). This hook
 * sticks to the safe surface — `beforeunload` plus a callback the
 * ObjectView's pager wires to its own confirm modal.
 */
export function useUnsavedChangesGuard(isDirty: boolean, message = 'Há alterações não salvas.') {
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Setting `returnValue` is the cross-browser way to trigger the
      // native prompt. Modern browsers ignore the custom string.
      e.returnValue = message;
      return message;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty, message]);
}
