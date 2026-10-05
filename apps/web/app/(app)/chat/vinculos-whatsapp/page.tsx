'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Alert, Anchor, Badge, Button, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { idFromRef } from '@delfrance/schemas';
import { formatTelefoneInternacional } from '@delfrance/core/phone';
import { usePermission } from '@/lib/auth';
import { CollectionSelect } from '@/components/collection-select/CollectionSelect';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { useWhatsappVinculos } from '../_hooks/useWhatsappVinculos';
import { motivoVinculo, estadoVinculo } from './motivoVinculo';

export default function WhatsappVinculosPage() {
  const { allowed, loading: permissionLoading } = usePermission(PERM.chat.read | PERM.cliente.read);
  const { allowed: canReadIntegracao } = usePermission(PERM.integracao.read);
  const [integracaoRef, setIntegracaoRef] = useState<unknown>(null);
  const integracaoId =
    typeof integracaoRef === 'string' ? (idFromRef(integracaoRef) ?? undefined) : undefined;
  const query = useWhatsappVinculos(integracaoId);
  if (permissionLoading) return <Loader />;
  if (!allowed)
    return <Alert color="yellow">Você não tem permissão para consultar contatos e clientes.</Alert>;
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Contatos aguardando vínculo</Title>
        <Anchor component={Link} href="/chat">
          Voltar ao Chat
        </Anchor>
      </Group>
      <Text c="dimmed">
        Vincule cada contato a um cliente para continuar o atendimento. As mensagens recebidas ficam
        preservadas.
      </Text>
      {canReadIntegracao && (
        <CollectionSelect
          collection={integracaoCollection}
          labelField="nome"
          fieldName="vinculosIntegracao"
          label="Integração"
          searchFields={['nome']}
          value={integracaoRef}
          onChange={setIntegracaoRef}
          limit={10}
        />
      )}
      {query.error && (
        <Alert color="red">
          {query.error.message}
          <Button variant="subtle" onClick={() => void query.refetch()}>
            Tentar novamente
          </Button>
        </Alert>
      )}
      {query.isLoading && <Loader />}
      {!query.isLoading && !query.error && rows.length === 0 && (
        <Text>Nenhum contato aguardando vínculo.</Text>
      )}
      {rows.map((row) => (
        <Stack
          key={row.id}
          p="md"
          gap={4}
          style={{ border: '1px solid var(--mantine-color-gray-3)', borderRadius: 8 }}
        >
          <Group justify="space-between">
            <Anchor component={Link} href={`/chat/vinculos-whatsapp/${encodeURIComponent(row.id)}`}>
              {row.nome ?? 'Contato sem nome'}
            </Anchor>
            <Badge color={row.estado === 'erro' ? 'red' : 'orange'}>
              {estadoVinculo(row.estado)}
            </Badge>
          </Group>
          <Text size="sm">
            {row.telefone ? formatTelefoneInternacional(row.telefone) : 'Telefone não informado'} ·{' '}
            {row.integracaoNome}
          </Text>
          <Text size="sm">{motivoVinculo(row.motivo)}</Text>
          <Text size="xs" c="dimmed">
            {row.quantidadeMensagens} mensagens ·{' '}
            {new Date(row.ultimaMensagemEm).toLocaleString('pt-BR')}
          </Text>
        </Stack>
      ))}
      {query.hasNextPage && (
        <Button loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          Carregar mais
        </Button>
      )}
    </Stack>
  );
}
