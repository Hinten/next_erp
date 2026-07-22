'use client';

import { useEffect, useState } from 'react';
import { TextInput } from '@mantine/core';

export interface SearchBarProps {
  placeholder?: string;
  /** Initial value — used to seed the controlled state. */
  initialValue?: string;
  /**
   * Fires the debounced term. Component owns its own value state so the
   * input stays snappy regardless of upstream query latency.
   */
  onChange: (term: string) => void;
  /** Debounce window in ms. Default 300ms. */
  debounceMs?: number;
}

/**
 * Debounced search input. Decouples keystroke rate from query rebuilds so
 * the caller can reconstruct queries inside `useMemo([term])` without
 * thrashing Firestore subscriptions.
 */
export function SearchBar({
  placeholder = 'Buscar…',
  initialValue = '',
  onChange,
  debounceMs = 300,
}: SearchBarProps) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    const handle = setTimeout(() => onChange(value), debounceMs);
    return () => clearTimeout(handle);
    // onChange is intentionally outside deps — callers typically pass an
    // inline arrow which would re-fire the timeout on every render.
  }, [value, debounceMs]);

  return (
    <TextInput
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.currentTarget.value)}
      aria-label="Buscar"
    />
  );
}
