'use client';

import Link from 'next/link';
import { Box, Button, Group, ScrollArea, Skeleton, Stack, Text } from '@mantine/core';
import { HighlightedText } from '@/lib/chat/highlight';
import { buildSnippet } from '@/lib/chat/globalSearch';
import { formatMensagemTime } from '@/lib/chat/mensagemTime';
import type { ConversaGroup, GlobalMatchRow } from '@/lib/chat/globalSearch';
import type { GlobalSearch } from '../../_hooks/useGlobalSearch';
import { useConversaNome } from '../../_hooks/useConversaNome';

/**
 * The cross-conversation search results list (PR-C5): matches grouped by
 * conversa (newest match first), each group headed by the conversa name (a
 * cached one-shot fetch) and listing snippet rows with the matched substrings
 * marked. A progress note ("X mensagens verificadas · Y correspondências") and a
 * "Buscar mais antigas" pager sit above/below. Clicking a row deep-links into
 * the thread in TARGET-WINDOW mode (`?msg=&ts=&busca=`).
 */
export function GlobalSearchResults({
  search,
  term,
  activeConversaId,
}: {
  search: GlobalSearch;
  term: string;
  activeConversaId?: string;
}) {
  const { groups, regex, checkedCount, matchCount, loading, loadingMore, error, exhausted } =
    search;

  return (
    <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
      <Text size="xs" c="dimmed" px={4}>
        {checkedCount} mensagens verificadas · {matchCount} correspondências
      </Text>
      {search.isLiteral && (
        <Text size="xs" c="orange" px={4}>
          busca literal (padrão inválido)
        </Text>
      )}
      {error && (
        <Group gap="xs" px={4}>
          <Text size="xs" c="red">
            Falha ao buscar: {error.message}
          </Text>
          {/* A failed FIRST page would otherwise dead-end (the pager below is
              hidden until something was fetched) — loadMore with a null cursor
              retries page 1. */}
          {!loading && !loadingMore && (
            <Button size="compact-xs" variant="light" onClick={() => void search.loadMore()}>
              Tentar novamente
            </Button>
          )}
        </Group>
      )}

      <ScrollArea style={{ flex: 1, minHeight: 0 }} offsetScrollbars>
        {loading && (
          <Stack gap={6}>
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} height={44} />
            ))}
          </Stack>
        )}

        {!loading && regex && search.hasFetched && groups.length === 0 && (
          <Text c="dimmed" size="sm" ta="center" py="xl">
            Nenhuma mensagem encontrada.
          </Text>
        )}

        <Stack gap="sm">
          {regex &&
            groups.map((group) => (
              <ConversaGroupBlock
                key={group.conversaId}
                group={group}
                regex={regex}
                term={term}
                active={group.conversaId === activeConversaId}
              />
            ))}
        </Stack>

        {regex && (groups.length > 0 || (!loading && checkedCount > 0)) && (
          <Box ta="center" py="sm">
            {exhausted ? (
              <Text size="xs" c="dimmed">
                Fim das mensagens
              </Text>
            ) : (
              <Button
                size="xs"
                variant="light"
                loading={loadingMore}
                onClick={() => void search.loadMore()}
              >
                Buscar mais antigas
              </Button>
            )}
          </Box>
        )}
      </ScrollArea>
    </Stack>
  );
}

function ConversaGroupBlock({
  group,
  regex,
  term,
  active,
}: {
  group: ConversaGroup;
  regex: RegExp;
  term: string;
  active: boolean;
}) {
  const nome = useConversaNome(group.conversaId);
  return (
    <Stack gap={2}>
      <Text
        size="xs"
        fw={700}
        c={active ? 'blue' : 'dimmed'}
        truncate
        px={4}
        style={{ textTransform: 'uppercase', letterSpacing: 0.3 }}
      >
        {nome}
      </Text>
      {group.matches.map((match) => (
        <MatchRow key={match.mensagemId} match={match} regex={regex} term={term} />
      ))}
    </Stack>
  );
}

function MatchRow({ match, regex, term }: { match: GlobalMatchRow; regex: RegExp; term: string }) {
  const snippet = buildSnippet(match.text, regex);
  const time = formatMensagemTime(match.timestamp);

  const params = new URLSearchParams();
  // Target-window mode needs BOTH msg and a finite ts (MensagemThread ignores a
  // lone msg param) — a null-timestamp match links to the plain conversa
  // instead of minting a dead-end deep link.
  if (match.timestamp != null) {
    params.set('msg', match.mensagemId);
    params.set('ts', String(match.timestamp));
  }
  if (term.trim() !== '') params.set('busca', term);
  const qs = params.toString();
  const href = qs ? `/chat/${match.conversaId}?${qs}` : `/chat/${match.conversaId}`;

  return (
    <Box
      component={Link}
      href={href}
      p={6}
      style={{
        display: 'block',
        borderRadius: 6,
        textDecoration: 'none',
        color: 'inherit',
        border: '1px solid var(--mantine-color-gray-2)',
      }}
    >
      <Text size="sm" lineClamp={2}>
        {snippet.prefixEllipsis && '…'}
        <HighlightedText text={snippet.text} regex={regex} />
        {snippet.suffixEllipsis && '…'}
      </Text>
      {time && (
        <Text size="xs" c="dimmed" mt={2}>
          {time}
        </Text>
      )}
    </Box>
  );
}
