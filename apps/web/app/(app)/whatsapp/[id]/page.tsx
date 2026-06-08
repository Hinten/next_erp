'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Alert, Badge, Box, Group, Select, Skeleton, Stack, Text, Title } from '@mantine/core';
import { setDoc } from 'firebase/firestore';
import { PageHeader } from '@delfrance/ui';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { ESTADO_CONVERSA, ESTADO_CONVERSA_LABELS, type EstadoConversa } from '@delfrance/schemas';
import { conversaCollection } from '@/lib/data/conversaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { WhatsAppList } from '../_components/WhatsAppList';
import { MensagemThread } from '../../chat/_components/MensagemThread';

const estadoOptions = (Object.values(ESTADO_CONVERSA) as EstadoConversa[])
  .sort((a, b) => a - b)
  .map((value) => ({
    value: String(value),
    label: ESTADO_CONVERSA_LABELS[value],
  }));

export default function WhatsAppDetailPage() {
  const params = useParams<{ id: string }>();
  const [search, setSearch] = useState('');

  const docRef = useMemo(
    () => conversaCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);

  async function handleEstadoChange(next: string | null) {
    if (next === null || !data) return;
    const nextEstado = Number(next) as EstadoConversa;
    if (nextEstado === data.data.estadoConversa) return;
    await setDoc(
      docRef,
      {
        estadoConversa: nextEstado,
        ultima_modificacao: new Date().toISOString(),
      },
      { merge: true },
    );
  }

  return (
    <Stack h="calc(100vh - 96px)" gap="md">
      <PageHeader title="WhatsApp" description="Inbox de WhatsApp Cloud API" />
      <Group align="stretch" gap="md" style={{ flex: 1, minHeight: 0 }}>
        <Box
          w={320}
          style={{
            borderRight: '1px solid var(--mantine-color-gray-2)',
            paddingRight: 12,
          }}
        >
          <WhatsAppList activeId={params.id} search={search} onSearchChange={setSearch} />
        </Box>
        <Stack style={{ flex: 1, minHeight: 0 }} gap={0}>
          {error && <Alert color="red">{error.message}</Alert>}
          {loading && <Skeleton height={64} m="md" />}
          {!loading && !data && (
            <Alert color="yellow" m="md">
              Conversa não encontrada.
            </Alert>
          )}
          {!loading && data && data.data.origem !== 'whatsapp' && (
            <Alert color="yellow" m="md">
              Esta conversa não é do WhatsApp. Use /chat.
            </Alert>
          )}
          {!loading && data && data.data.origem === 'whatsapp' && (
            <>
              <Box p="md" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
                <Group justify="space-between" wrap="nowrap">
                  <Stack gap={2}>
                    <Title order={4}>{data.data.nome}</Title>
                    <Group gap="xs">
                      <Badge variant="light" color="green">
                        WhatsApp
                      </Badge>
                      {data.data.atendido && (
                        <Badge variant="light" color="green">
                          Atendido
                        </Badge>
                      )}
                      {data.data.sender_id && (
                        <Text size="xs" c="dimmed">
                          {data.data.sender_id}
                        </Text>
                      )}
                    </Group>
                  </Stack>
                  <Select
                    data={estadoOptions}
                    value={String(data.data.estadoConversa)}
                    onChange={handleEstadoChange}
                    w={240}
                    size="xs"
                  />
                </Group>
              </Box>
              <Box style={{ flex: 1, minHeight: 0 }}>
                <MensagemThread conversaId={data.id} />
              </Box>
            </>
          )}
        </Stack>
      </Group>
    </Stack>
  );
}
