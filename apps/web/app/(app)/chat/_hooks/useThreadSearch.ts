'use client';

import { useEffect, useMemo, useState } from 'react';
import { buildSearchRegex, searchableText, testRegex } from '@/lib/chat/searchRegex';
import { type AnyMensagem, mensagemKey } from './useMensagensWindow';

export interface ThreadSearch {
  /** The effective regex (user pattern or literal fallback), or null when idle. */
  regex: RegExp | null;
  /** True when the user's pattern was invalid/zero-width → fell back to literal. */
  isLiteral: boolean;
  /** Matching message keys in chronological order. */
  matches: string[];
  /** The 0-based index of the active match within {@link matches} (or -1). */
  currentIndex: number;
  total: number;
  /** The active match's message key (for scroll-into-view), or null. */
  currentId: string | null;
  next: () => void;
  prev: () => void;
}

/**
 * In-thread regex search over the loaded window — a regex-capable port of the
 * legacy substring search (`conversaManager.dart:136-226`). Builds a case-
 * insensitive, unicode `RegExp` from `term`; on a `SyntaxError` (or a zero-width
 * pattern that would match the empty string) it falls back to a LITERAL search
 * (`escapeRegExp`) and flags `isLiteral` so the UI can show a "busca literal"
 * hint. Matches are message-level and chronological (legacy navigated between
 * whole matching messages); `next`/`prev` cycle with wraparound.
 */
export function useThreadSearch(term: string, messages: AnyMensagem[]): ThreadSearch {
  // The active match is tracked by a STABLE key (the mensagem doc id), not by a
  // positional index: when an older page prepends, matches recompute with new
  // entries at the FRONT, so a bare index would silently point at a different
  // message. `null` means "follow the first match" (the fresh-search default).
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // The last resolved index, kept so that when the active message disappears
  // (aged out of the window) the fallback lands on the NEAREST match rather than
  // jumping back to the top. State (not a ref) so it is read cleanly in render.
  const [nearestIndex, setNearestIndex] = useState(0);

  const { regex, isLiteral } = useMemo(() => buildSearchRegex(term), [term]);

  const matches = useMemo(() => {
    if (!regex) return [];
    // A fresh, non-global copy for `.test()` — a global regex's stateful
    // `lastIndex` would make repeated tests skip messages.
    const test = testRegex(regex);
    const ids: string[] = [];
    for (const m of messages) {
      const text = searchableText(m);
      if (text != null && test.test(text)) ids.push(mensagemKey(m));
    }
    return ids;
  }, [regex, messages]);

  // Reset to the first hit when the term changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the active match on a new search term; converges
    setActiveKey(null);
  }, [term]);

  const total = matches.length;
  // Re-locate the active match by its stable key each render: a prepended older
  // page shifts positional indices, but the SAME message stays selected.
  let currentIndex: number;
  if (total === 0) {
    currentIndex = -1;
  } else if (activeKey == null) {
    currentIndex = 0;
  } else {
    const found = matches.indexOf(activeKey);
    currentIndex = found >= 0 ? found : Math.min(nearestIndex, total - 1);
  }
  const currentId = currentIndex >= 0 ? (matches[currentIndex] ?? null) : null;

  // Cache the resolved index for the fallback above. Guarded so it only writes on
  // a real change (converges: the clamped fallback is <= total-1, so re-caching
  // it never moves the target again).
  useEffect(() => {
    if (currentIndex >= 0 && currentIndex !== nearestIndex) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- caching the resolved match index for fallback; guarded, converges
      setNearestIndex(currentIndex);
    }
  }, [currentIndex, nearestIndex]);

  return {
    regex,
    isLiteral,
    matches,
    currentIndex,
    total,
    currentId,
    next: () => {
      if (total > 0) setActiveKey(matches[(currentIndex + 1) % total] ?? null);
    },
    prev: () => {
      if (total > 0) setActiveKey(matches[(currentIndex - 1 + total) % total] ?? null);
    },
  };
}
