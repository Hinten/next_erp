'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import {
  Anchor,
  Badge,
  Group,
  Skeleton,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useRouter } from 'next/navigation';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { ESTADO_CONVERSA_LABELS, ORIGEM_LABELS, type Conversa } from '@delfrance/schemas';
import { conversaCollection } from '@/lib/data/conversaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

const PAGE_SIZE = 100;

/**
 * Sidebar of conversas. Real-time, ordered by `ultima_modificacao` desc
 * (matches Flutter client behavior). Filters by free-text on `nome`
 * client-side — small list, cheap.
 */
export function ConversaList({
  activeId,
  search,
  onSearchChange,
}: {
  activeId?: string;
  search: string;
  onSearchChange: (v: string) => void;
}) {
  const router = useRouter();
  const q = useMemo(() => {
    const base = conversaCollection.ref(getFirebaseFirestore(), {});
    return buildQuery(base, [orderByField('ultima_modificacao', 'desc'), limit(PAGE_SIZE)]);
  }, []);

  const { data, loading, error } = useSnapshot<Conversa>(q);

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return data;
    return data.filter(({ data: c }) => (c.nome ?? '').toLowerCase().includes(needle));
  }, [data, search]);

  return (
    <Stack gap="xs">
      <TextInput
        placeholder="Filtrar conversas…"
        value={search}
        onChange={(e) => onSearchChange(e.currentTarget.value)}
        size="sm"
      />

      {error && (
        <Text c="red" size="sm">
          {error.message}
        </Text>
      )}

      {loading && (
        <Stack gap={6}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} height={56} />
          ))}
        </Stack>
      )}

      {!loading && filtered.length === 0 && (
        <Text c="dimmed" size="sm" ta="center" py="md">
          Nenhuma conversa.
        </Text>
      )}

      <Stack gap={2}>
        {filtered.map(({ id, data: c }) => (
          <ConversaRow
            key={id}
            id={id}
            conversa={c}
            active={id === activeId}
            onSelect={() => router.push(`/chat/${id}`)}
          />
        ))}
      </Stack>
    </Stack>
  );
}

function ConversaRow({
  id,
  conversa,
  active,
  onSelect,
}: {
  id: string;
  conversa: Conversa;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <UnstyledButton
      onClick={onSelect}
      p="xs"
      style={(theme) => ({
        borderRadius: theme.radius.sm,
        backgroundColor: active ? theme.colors.blue[0] : undefined,
        borderLeft: active ? `3px solid ${theme.colors.blue[6]}` : '3px solid transparent',
      })}
    >
      <Stack gap={4}>
        <Group justify="space-between" wrap="nowrap">
          <Text fw={600} size="sm" lineClamp={1}>
            {conversa.nome}
          </Text>
          <Badge size="xs" variant="light" color="gray">
            {ORIGEM_LABELS[conversa.origem]}
          </Badge>
        </Group>
        <Group justify="space-between" gap={4}>
          <Text size="xs" c="dimmed" lineClamp={1}>
            {ESTADO_CONVERSA_LABELS[conversa.estadoConversa]}
          </Text>
          {conversa.ultima_modificacao && (
            <Text size="xs" c="dimmed">
              {new Date(conversa.ultima_modificacao).toLocaleString('pt-BR', {
                hour: '2-digit',
                minute: '2-digit',
                day: '2-digit',
                month: '2-digit',
              })}
            </Text>
          )}
        </Group>
      </Stack>
      {/* No-op anchor for keyboard users with deep-link affordance */}
      <Anchor component={Link} href={`/chat/${id}`} style={{ display: 'none' }} />
    </UnstyledButton>
  );
}
