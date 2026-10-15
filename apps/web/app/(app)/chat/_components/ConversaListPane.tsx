'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  ScrollArea,
  Skeleton,
  Stack,
  Tabs,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconChecklist, IconSearch } from '@tabler/icons-react';
import type { Conversa } from '@delfrance/schemas';
import { CONVERSA_TABS, TAB_LABELS, type ConversaTab } from '@/lib/chat/conversaConstraints';
import { useAuth } from '@/lib/auth';
import { useConversaFilters } from '../_hooks/useConversaFilters';
import { useConversaQuery } from '../_hooks/useConversaQuery';
import { useChatBadges } from '../_hooks/useChatBadges';
import { ConversaTile } from './ConversaTile';
import { FiltersBar } from './FiltersBar';
import { BulkActionsBar } from './BulkActionsBar';
import { GlobalSearchPane } from './search/GlobalSearchPane';

/**
 * The inbox list pane: tabs (with live badges), filters, bulk selection, and
 * the real-time conversa list with a "Carregar mais" one-shot pager. Ports the
 * legacy `MenuLateral` list column (`.old/lib/chat/menu_lateral.dart`).
 */
export function ConversaListPane({ activeId }: { activeId?: string }) {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const filters = useConversaFilters();
  const badges = useChatBadges(uid);

  const { rows, loading, error, hasMore, loadingMore, loadMore } = useConversaQuery({
    tab: filters.tab,
    ordem: filters.ordem,
    uid,
    integracaoId: filters.integracaoId,
    etiqueta: filters.etiqueta,
    clienteOuterRef: filters.clienteRef,
  });

  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      if (rows.length > 0 && rows.every((r) => prev.has(r.id))) return new Set();
      return new Set(rows.map((r) => r.id));
    });
  }, [rows]);

  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    setSelected(new Set());
  }, []);

  const selectedIds = useMemo(() => [...selected], [selected]);

  const badgeFor = (tab: ConversaTab): string | null =>
    tab === 'atendimento' ? badges.atendimento : tab === 'pendentes' ? badges.pendentes : null;

  // Search mode is driven by the PRESENCE of the `busca` param (even empty), so
  // the cross-conversation search survives navigating into a thread and back.
  if (filters.busca !== null) {
    return (
      <GlobalSearchPane
        initialTerm={filters.busca}
        onTermChange={(v) => filters.setBusca(v)}
        onClose={() => filters.setBusca(null)}
        activeConversaId={activeId}
      />
    );
  }

  return (
    <Stack gap="xs" h="100%" style={{ minHeight: 0 }}>
      <Tabs value={filters.tab} onChange={(v) => v && filters.setTab(v as ConversaTab)}>
        <Tabs.List grow>
          {CONVERSA_TABS.map((tab) => {
            const badge = badgeFor(tab);
            return (
              <Tabs.Tab
                key={tab}
                value={tab}
                rightSection={
                  badge ? (
                    <Badge size="xs" circle color="orange" variant="filled">
                      {badge}
                    </Badge>
                  ) : undefined
                }
              >
                {TAB_LABELS[tab]}
              </Tabs.Tab>
            );
          })}
        </Tabs.List>
      </Tabs>

      <FiltersBar filters={filters} />

      <Group justify="space-between" gap="xs">
        <Group gap="xs">
          <Tooltip label={selectionMode ? 'Sair da seleção' : 'Selecionar em massa'} withArrow>
            <ActionIcon
              variant={selectionMode ? 'filled' : 'subtle'}
              aria-label="Selecionar em massa"
              onClick={() => (selectionMode ? exitSelection() : setSelectionMode(true))}
            >
              <IconChecklist size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Buscar em todas as conversas" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Buscar em todas as conversas"
              onClick={() => filters.setBusca('')}
            >
              <IconSearch size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
        {selectionMode && (
          <Checkbox
            size="xs"
            label="Selecionar todos"
            checked={allVisibleSelected}
            indeterminate={selected.size > 0 && !allVisibleSelected}
            onChange={toggleSelectAll}
          />
        )}
      </Group>

      {selectionMode && selectedIds.length > 0 && (
        <BulkActionsBar selectedIds={selectedIds} onApplied={exitSelection} />
      )}

      {error && <Alert color="red">{error.message}</Alert>}

      <ScrollArea style={{ flex: 1, minHeight: 0 }} offsetScrollbars>
        {loading && (
          <Stack gap={6}>
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} height={56} />
            ))}
          </Stack>
        )}

        {!loading && rows.length === 0 && (
          <Text c="dimmed" size="sm" ta="center" py="xl">
            Nenhuma conversa.
          </Text>
        )}

        <Stack gap={2}>
          {rows.map((row) => (
            <ConversaTile
              key={row.id}
              id={row.id}
              conversa={row.data as Conversa}
              active={row.id === activeId}
              href={filters.buildHref(row.id)}
              meuUid={uid}
              selectable={selectionMode}
              selected={selected.has(row.id)}
              onToggleSelect={toggleSelect}
            />
          ))}
        </Stack>

        {hasMore && (
          <Box ta="center" py="sm">
            <Button size="xs" variant="light" loading={loadingMore} onClick={loadMore}>
              Carregar mais
            </Button>
          </Box>
        )}
      </ScrollArea>
    </Stack>
  );
}
