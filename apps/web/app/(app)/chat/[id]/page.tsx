'use client';

import { useMemo } from 'react';
import { useParams } from 'next/navigation';
import { Alert, Badge, Box, Group, Select, Skeleton, Stack, Text, Title } from '@mantine/core';
import { setDoc } from 'firebase/firestore';
import { useDocSnapshot } from '@delfrance/data/hooks';
import {
  ESTADO_CONVERSA,
  ESTADO_CONVERSA_LABELS,
  ORIGEM_LABELS,
  type EstadoConversa,
} from '@delfrance/schemas';
import { conversaCollection } from '@/lib/data/conversaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { ChatInboxShell } from '../_components/ChatInboxShell';
import { MensagemThread } from '../_components/MensagemThread';

const estadoOptions = (Object.values(ESTADO_CONVERSA) as EstadoConversa[])
  .sort((a, b) => a - b)
  .map((value) => ({
    value: String(value),
    label: ESTADO_CONVERSA_LABELS[value],
  }));

export default function ConversaDetailPage() {
  const params = useParams<{ id: string }>();

  const docRef = useMemo(
    () => conversaCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);

  async function handleEstadoChange(next: string | null) {
    if (next === null || !data) return;
    const nextEstado = Number(next) as EstadoConversa;
    if (nextEstado === data.data.estadoConversa) return;
    // Strip the converter for this PATCH: the converter's toFirestore runs a
    // full schema.parse, which fills every defaulted field — a converted
    // merge would clobber nome/origem/refs/etiqueta with schema defaults
    // (same rationale as BulkActionsBar's raw patch).
    await setDoc(
      docRef.withConverter(null),
      {
        estadoConversa: nextEstado,
        ultima_modificacao: Date.now(),
      },
      { merge: true },
    );
  }

  return (
    <ChatInboxShell activeId={params.id}>
      <Stack style={{ flex: 1, minHeight: 0 }} gap={0}>
        {error && <Alert color="red">{error.message}</Alert>}
        {loading && <Skeleton height={64} m="md" />}
        {!loading && !data && (
          <Alert color="yellow" m="md">
            Conversa não encontrada.
          </Alert>
        )}
        {!loading && data && (
          <>
            <Box
              p="md"
              style={{
                borderBottom: '1px solid var(--mantine-color-gray-2)',
              }}
            >
              <Group justify="space-between" wrap="nowrap">
                <Stack gap={2}>
                  <Title order={4}>{data.data.nome}</Title>
                  <Group gap="xs">
                    <Badge variant="light">{ORIGEM_LABELS[data.data.origem]}</Badge>
                    {data.data.atendido && (
                      <Badge variant="light" color="green">
                        Atendido
                      </Badge>
                    )}
                    {data.data.prazo_resposta && (
                      <Text size="xs" c="dimmed">
                        Prazo: {new Date(data.data.prazo_resposta).toLocaleString('pt-BR')}
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
    </ChatInboxShell>
  );
}
