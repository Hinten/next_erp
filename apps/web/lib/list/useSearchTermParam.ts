'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * A list screen's free-text search term, mirrored into the URL and remembered
 * per screen for the browser-tab session — the page-owned counterpart of
 * `TableView`'s built-in `search` prop.
 *
 * Most lists should use that prop instead: it owns the term, the query and the
 * chip in one place. This hook exists for the two screens that CANNOT, because
 * their term is not synchronously expressible as a filter — `/clientes` resolves
 * an address term into a capped id list through a TanStack query, and
 * `/nfe/comunicacoes` resolves a chave/pedido term into a chave list. Both also
 * unmount their `TableView` while resolving, so the term cannot live inside it.
 *
 * Precedence matches `useTableUrlState`: the URL wins, and the remembered term
 * applies only when the URL carries none — so a shared link is never overridden,
 * while arriving back from a record on the bare list path restores what the
 * operator had typed.
 */

const PREFIX = 'delfrance:list-search:';

function memoryKey(pathname: string, param: string): string {
  return `${PREFIX}${pathname}:${param}`;
}

/** The remembered term for a screen, or '' when there is none / storage is unavailable. */
export function readSearchTerm(pathname: string, param: string): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.sessionStorage.getItem(memoryKey(pathname, param)) ?? '';
  } catch (err) {
    // Private mode / disabled storage throws a DOMException — that is "nothing
    // remembered", not a failure. Rethrow anything else (repo rule 6).
    if (err instanceof DOMException) return '';
    throw err;
  }
}

/** Remember (or, for an empty term, forget) a screen's search term. */
export function writeSearchTerm(pathname: string, param: string, term: string): void {
  if (typeof window === 'undefined') return;
  const key = memoryKey(pathname, param);
  try {
    if (term === '') window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, term);
  } catch (err) {
    if (err instanceof DOMException) return;
    throw err;
  }
}

/**
 * Merge one param into the current URL without touching anything else.
 *
 * `history.replaceState` rather than `router.replace` for the same reasons
 * `useTableUrlState` documents: these pages are client-rendered, so a router
 * navigation needlessly refetches the RSC, and on a statically-prerendered route
 * a search-param-only `router.replace` is silently deduped away.
 */
function mirrorToUrl(pathname: string, param: string, term: string): void {
  const params = new URLSearchParams(window.location.search);
  if (term === '') params.delete(param);
  else params.set(param, term);
  const qs = params.toString();
  const next = qs ? `${pathname}?${qs}` : pathname;
  if (next !== `${pathname}${window.location.search}`) {
    window.history.replaceState(null, '', next);
  }
}

export function useSearchTermParam(param = 'q'): [string, (term: string) => void] {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Resolved once, on the first render — the same synchronous restore
  // `useTableUrlState` does, and safe for the same reason: the `(app)` layout
  // renders a bare loader until auth resolves, so no list is ever part of a
  // server render or the hydration pass.
  const [term, setTerm] = useState(
    () => searchParams.get(param) ?? readSearchTerm(pathname, param),
  );

  // Reconcile the two tiers on mount, in whichever direction is missing.
  //
  // A term recovered from the memory is not in the URL yet — put it there, so
  // the address bar agrees with the input and a reload (or a copied link)
  // reproduces what is on screen.
  //
  // ⚠️ And the inverse, which is the easier half to forget: a term that arrived
  // FROM the URL was never written to the memory, because only `commit` writes
  // and the operator never typed. The screen would then hold a stale older term
  // and restore THAT on the next bare-path return — showing a search the
  // operator had already navigated away from. `useTableUrlState` has no such
  // gap: its sync effect persists on its first run too. Match it.
  const openingTerm = useRef(term);
  useEffect(() => {
    if (searchParams.get(param) === null) {
      if (openingTerm.current !== '') mirrorToUrl(pathname, param, openingTerm.current);
    } else {
      writeSearchTerm(pathname, param, openingTerm.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design
  }, []);

  const commit = useCallback(
    (next: string) => {
      setTerm(next);
      mirrorToUrl(pathname, param, next);
      writeSearchTerm(pathname, param, next);
    },
    [pathname, param],
  );

  return [term, commit];
}
