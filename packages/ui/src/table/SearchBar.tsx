'use client';

import { useEffect, useRef, useState } from 'react';
import { TextInput } from '@mantine/core';

export interface SearchBarProps {
  placeholder?: string;
  /**
   * The COMMITTED term. Owned by the caller — `TableView` keeps it in the URL
   * query (`?q=`), which is what lets a restored term arrive here after mount.
   */
  value: string;
  /**
   * Fires the debounced term. The component owns a private draft so the input
   * stays snappy regardless of upstream query latency.
   */
  onChange: (term: string) => void;
  /** Debounce window in ms. Default 300ms. */
  debounceMs?: number;
}

/**
 * Debounced search input. Decouples keystroke rate from query rebuilds so the
 * caller can reconstruct queries inside `useMemo([term])` without thrashing
 * Firestore subscriptions.
 *
 * Controlled outward-debounced, NOT uncontrolled-with-a-seed. The distinction
 * is load-bearing for the sticky list memory: a restored term is applied one
 * tick AFTER mount, so a `useState(initialValue)` seed would never see it and
 * the box would sit empty over a filtered list.
 *
 * ⚠️ `emitted` is what makes that safe. It records the last term this component
 * either emitted upward or accepted downward, which is the only way to tell an
 * externally-changed `value` (a restore, or "Limpar filtros") apart from the
 * echo of our own debounced emit — without it the two effects below feed each
 * other. It is also the guard that stops the debounce from firing on mount:
 * this component used to emit `onChange('')` ~300ms after every mount with no
 * skip-first guard, which silently wiped any term restored in that window,
 * intermittently, with every test green.
 */
export function SearchBar({
  placeholder = 'Buscar…',
  value,
  onChange,
  debounceMs = 300,
}: SearchBarProps) {
  const [draft, setDraft] = useState(value);
  const emitted = useRef(value);

  // Downward: the caller changed the committed term under us (sticky restore,
  // "Limpar filtros", a shared link). Adopt it into the draft.
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    setDraft(value);
  }, [value]);

  // Upward: the operator typed. `draft === emitted.current` means there is
  // nothing new to say — which covers the mount, and covers typing then
  // deleting back to the committed term before the debounce lands.
  useEffect(() => {
    if (draft === emitted.current) return;
    const handle = setTimeout(() => {
      emitted.current = draft;
      onChange(draft);
    }, debounceMs);
    return () => clearTimeout(handle);
    // onChange is intentionally outside deps — callers typically pass an
    // inline arrow which would re-fire the timeout on every render.
  }, [draft, debounceMs]);

  return (
    <TextInput
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.currentTarget.value)}
      aria-label="Buscar"
    />
  );
}
