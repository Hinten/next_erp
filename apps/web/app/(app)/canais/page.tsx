'use client';

import { useMemo } from 'react';
import {
  Alert,
  Badge,
  Card,
  Code,
  Group,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import { buildQuery, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import {
  INTEGRACAO_TIPO_LABELS,
  type Integracao,
  type IntegracaoTipo,
  pluginIdForTipo,
} from '@delfrance/schemas';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function CanaisListPage() {
  const q = useMemo(() => {
    const base = integracaoCollection.ref(getFirebaseFirestore(), {});
    return buildQuery(base, [orderByField('nome', 'asc')]);
  }, []);

  const { data, loading, error } = useSnapshot<Integracao>(q);

  return (
    <Stack>
      <PageHeader
        title="Canais de venda"
        description="Integrações configuradas (Mercado Livre, Shopee, Amazon, Magalu, Loja Integrada, Facebook, WhatsApp, balcão)"
      />

      <Alert color="blue" title="OAuth + sincronização">
        A configuração inicial (OAuth) e sincronização contínua (catálogo,
        pedidos, tracking) vivem em
        <Code mx={4}>apps/integrations</Code>+ Cloud Functions. Esta tela é
        a visão consolidada das integrações já cadastradas no Firestore.
        Plugins de canal (
        <Code>@delfrance/integrations-mercado-livre</Code>,
        <Code>@delfrance/integrations-shopee</Code>, etc.) são scaffolds
        hoje; implementação concreta entra na Fase 5.
      </Alert>

      {error && <Alert color="red">{error.message}</Alert>}

      {loading && (
        <Group grow>
          <Skeleton height={120} />
          <Skeleton height={120} />
        </Group>
      )}

      {!loading && data && data.length === 0 && (
        <Text c="dimmed">Nenhuma integração cadastrada.</Text>
      )}

      {!loading && data && (
        <Group align="stretch">
          {data.map(({ id, data: i }) => (
            <IntegracaoCard key={id} id={id} integracao={i} />
          ))}
        </Group>
      )}
    </Stack>
  );
}

function IntegracaoCard({
  id,
  integracao,
}: {
  id: string;
  integracao: Integracao;
}) {
  const tipoLabel = INTEGRACAO_TIPO_LABELS[integracao.tipo as IntegracaoTipo];
  const pluginId = pluginIdForTipo(integracao.tipo as IntegracaoTipo);
  return (
    <Card withBorder padding="md" w={280} shadow="xs">
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={600}>{integracao.nome}</Text>
          {integracao.ativo ? (
            <Badge color="green" variant="light">
              Ativo
            </Badge>
          ) : (
            <Badge color="gray" variant="light">
              Inativo
            </Badge>
          )}
        </Group>
        <Text size="sm" c="dimmed">
          {tipoLabel}
        </Text>
        {integracao.padrao && (
          <Badge variant="outline" color="blue" size="xs">
            Padrão
          </Badge>
        )}
        <Group gap="xs">
          <Tooltip
            label={
              pluginId
                ? `Plugin: @delfrance/integrations-${pluginId}`
                : 'Sem plugin associado'
            }
          >
            <Badge variant="light" color={pluginId ? 'blue' : 'gray'} size="xs">
              {pluginId ?? 'sem plugin'}
            </Badge>
          </Tooltip>
        </Group>
        <Text size="xs" c="dimmed">
          ID: {id}
        </Text>
      </Stack>
    </Card>
  );
}
