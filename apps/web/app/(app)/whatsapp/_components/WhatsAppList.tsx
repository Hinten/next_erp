'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Group, Skeleton, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { buildQuery, limit, orderByField, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { ESTADO_CONVERSA_LABELS, type Conversa } from '@delfrance/schemas';
import { conversaCollection } from '@/lib/data/conversaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

const PAGE_SIZE = 100;

/**
 * WhatsApp inbox sidebar: same Conversa collection as /chat, but
 * filtered to origem='whatsapp' so operators only see WhatsApp
 * conversas.
 */
export function WhatsAppList({
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
    return buildQuery(base, [
      whereEqual('origem', 'whatsapp'),
      orderByField('ultima_modificacao', 'desc'),
      limit(PAGE_SIZE),
    ]);
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
        placeholder="Filtrar conversas WhatsApp…"
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
          Sem conversas no WhatsApp.
        </Text>
      )}

      <Stack gap={2}>
        {filtered.map(({ id, data: c }) => (
          <UnstyledButton
            key={id}
            onClick={() => router.push(`/whatsapp/${id}`)}
            p="xs"
            style={(theme) => ({
              borderRadius: theme.radius.sm,
              backgroundColor: id === activeId ? theme.colors.green[0] : undefined,
              borderLeft:
                id === activeId ? `3px solid ${theme.colors.green[6]}` : '3px solid transparent',
            })}
          >
            <Stack gap={4}>
              <Group justify="space-between" wrap="nowrap">
                <Text fw={600} size="sm" lineClamp={1}>
                  {c.nome}
                </Text>
                {c.atendido && (
                  <Badge size="xs" variant="light" color="green">
                    Atendido
                  </Badge>
                )}
              </Group>
              <Group justify="space-between" gap={4}>
                <Text size="xs" c="dimmed" lineClamp={1}>
                  {ESTADO_CONVERSA_LABELS[c.estadoConversa]}
                </Text>
                {c.ultima_modificacao && (
                  <Text size="xs" c="dimmed">
                    {new Date(c.ultima_modificacao).toLocaleString('pt-BR', {
                      hour: '2-digit',
                      minute: '2-digit',
                      day: '2-digit',
                      month: '2-digit',
                    })}
                  </Text>
                )}
              </Group>
            </Stack>
          </UnstyledButton>
        ))}
      </Stack>
    </Stack>
  );
}
