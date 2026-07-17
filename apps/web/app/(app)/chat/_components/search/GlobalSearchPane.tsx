'use client';

import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Group, Stack, TextInput, Tooltip } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { useGlobalSearch } from '../../_hooks/useGlobalSearch';
import { GlobalSearchResults } from './GlobalSearchResults';

/**
 * The list-pane GLOBAL SEARCH mode (PR-C5): swaps the tabs/filters/list for a
 * search input + grouped cross-conversation results. The input term is LOCAL
 * state (snappy typing, instant in-memory re-match) mirrored to the URL `busca`
 * param via `onTermChange` so the search survives navigation into a thread and
 * back; the pane is (re)seeded from that param on mount. Esc / the X icon exit
 * (`onClose` clears the param).
 */
export function GlobalSearchPane({
  initialTerm,
  onTermChange,
  onClose,
  activeConversaId,
}: {
  initialTerm: string;
  onTermChange: (term: string) => void;
  onClose: () => void;
  activeConversaId?: string;
}) {
  const [term, setTerm] = useState(initialTerm);
  const search = useGlobalSearch(term);

  // The URL mirror (?busca=) exists for persistence across navigation — it
  // does NOT drive matching (local state does, so typing re-matches in
  // memory instantly). Debounce it: an un-debounced mirror costs one
  // router.replace App-Router navigation per keystroke.
  const mirrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mirrorTerm = (v: string) => {
    if (mirrorTimer.current) clearTimeout(mirrorTimer.current);
    mirrorTimer.current = setTimeout(() => onTermChange(v), 300);
  };
  useEffect(
    () => () => {
      if (mirrorTimer.current) clearTimeout(mirrorTimer.current);
    },
    [],
  );

  return (
    <Stack gap="xs" h="100%" style={{ minHeight: 0 }}>
      <Group gap="xs" wrap="nowrap">
        <TextInput
          value={term}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setTerm(v);
            mirrorTerm(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Buscar em todas as conversas (regex)…"
          style={{ flex: 1 }}
          autoFocus
          aria-label="Buscar em todas as conversas"
        />
        <Tooltip label="Fechar busca (Esc)">
          <ActionIcon
            variant="subtle"
            color="gray"
            onClick={onClose}
            aria-label="Fechar busca global"
          >
            <IconX size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>

      <GlobalSearchResults search={search} term={term} activeConversaId={activeConversaId} />
    </Stack>
  );
}
