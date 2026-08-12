'use client';

import { useMemo } from 'react';
import { useParams } from 'next/navigation';
import { Alert, Badge, Box, Group, Skeleton, Stack, Text, Title } from '@mantine/core';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { ESTADO_CONVERSA_LABELS, ORIGEM_LABELS } from '@delfrance/schemas';
import { conversaCollection } from '@/lib/data/conversaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { ChatInboxShell } from '../_components/ChatInboxShell';
import { ConversaSidePanel } from '../_components/ConversaSidePanel';
import { ConversaActionsMenu } from '../_components/actions/ConversaActionsMenu';
import { MensagemThread } from '../_components/MensagemThread';

export default function ConversaDetailPage() {
  const params = useParams<{ id: string }>();

  const docRef = useMemo(
    () => conversaCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);

  return (
    <ChatInboxShell
      activeId={params.id}
      rightPane={!loading && data ? <ConversaSidePanel conversa={data.data} /> : undefined}
    >
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
                    {/* The estado now surfaces read-only here — every change goes
                        through the actions menu so it writes its lifecycle event
                        (parity with legacy), replacing the old free-form Select. */}
                    <Badge variant="light" color="gray">
                      {ESTADO_CONVERSA_LABELS[data.data.estadoConversa]}
                    </Badge>
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
                <ConversaActionsMenu conversaId={data.id} conversa={data.data} />
              </Group>
            </Box>
            <Box style={{ flex: 1, minHeight: 0 }}>
              {/* key by conversa id: switching conversa remounts the thread so
                  its paged/optimistic window state resets cleanly. */}
              <MensagemThread key={data.id} conversaId={data.id} conversa={data.data} />
            </Box>
          </>
        )}
      </Stack>
    </ChatInboxShell>
  );
}
