'use client';

import { ActionIcon, Box, Button, Group, Text, TextInput, Tooltip } from '@mantine/core';
import { IconChevronDown, IconChevronUp, IconX } from '@tabler/icons-react';
import type { ThreadSearch } from '../../_hooks/useThreadSearch';

/**
 * In-thread search bar — swaps the composer while searching (legacy
 * `_searchMsgInput`, `.old/lib/chat/basico/chat_input.dart:476-556`): a text
 * input, an `n/total` hit counter, prev/next navigation, a "Buscar mais
 * antigas" (load an older page then re-match), and a "busca literal" hint when
 * an invalid/zero-width pattern fell back to a literal search. Esc closes.
 */
export function ThreadSearchBar({
  term,
  onTermChange,
  search,
  onClose,
  onLoadOlder,
  loadingOlder,
  exhausted,
}: {
  term: string;
  onTermChange: (v: string) => void;
  search: ThreadSearch;
  onClose: () => void;
  onLoadOlder: () => void;
  loadingOlder: boolean;
  exhausted: boolean;
}) {
  const counter = search.total === 0 ? '0/0' : `${search.currentIndex + 1}/${search.total}`;

  return (
    <Box p="sm" style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}>
      <Group gap="xs" wrap="nowrap">
        <TextInput
          value={term}
          onChange={(e) => onTermChange(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey) search.prev();
              else search.next();
            }
          }}
          placeholder="Buscar mensagens (regex)…"
          style={{ flex: 1 }}
          autoFocus
          aria-label="Buscar mensagens"
        />
        <Text
          size="xs"
          c="dimmed"
          style={{ whiteSpace: 'nowrap', minWidth: 44, textAlign: 'center' }}
        >
          {counter}
        </Text>
        <Tooltip label="Anterior (Shift+Enter)">
          <ActionIcon
            variant="subtle"
            color="gray"
            disabled={search.total === 0}
            onClick={search.prev}
            aria-label="Resultado anterior"
          >
            <IconChevronUp size={18} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Próximo (Enter)">
          <ActionIcon
            variant="subtle"
            color="gray"
            disabled={search.total === 0}
            onClick={search.next}
            aria-label="Próximo resultado"
          >
            <IconChevronDown size={18} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Fechar busca (Esc)">
          <ActionIcon variant="subtle" color="gray" onClick={onClose} aria-label="Fechar busca">
            <IconX size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Group justify="space-between" mt={4}>
        {search.isLiteral ? (
          <Text size="xs" c="orange">
            busca literal (padrão inválido)
          </Text>
        ) : (
          <span />
        )}
        {!exhausted && (
          <Button size="compact-xs" variant="subtle" loading={loadingOlder} onClick={onLoadOlder}>
            Buscar mais antigas
          </Button>
        )}
      </Group>
    </Box>
  );
}
