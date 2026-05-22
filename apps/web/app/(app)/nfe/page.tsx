'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import {
  Alert,
  Anchor,
  Code,
  Skeleton,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import { buildQuery, limit, orderByField, whereOp } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import type { Pedido } from '@delfrance/schemas';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

const PAGE_SIZE = 100;

/**
 * NFe surface in apps/web is a read-only view today: lists pedidos that
 * already carry chNFeReferenciadas (the 44-char SEFAZ chave), with
 * deep-link to the parent pedido. Emission, signing, and SEFAZ
 * round-trip live in apps/nfe (the deployable NF-e API host) via the
 * `consultarStatusServico` / `consultarSituacaoNFe` / `autorizarLote`
 * helpers in `@delfrance/integrations-nfe/operations`. The "Emitir NFe"
 * action that POSTs to apps/nfe lands in Phase A11.
 */
export default function NfeListPage() {
  const q = useMemo(() => {
    const base = pedidoCollection.ref(getFirebaseFirestore(), {});
    return buildQuery(base, [
      whereOp('chNFeReferenciadas', '!=', null),
      orderByField('numero', 'desc'),
      limit(PAGE_SIZE),
    ]);
  }, []);

  const { data, loading, error } = useSnapshot<Pedido>(q);

  return (
    <Stack>
      <PageHeader
        title="NFe"
        description="Notas Fiscais Eletrônicas vinculadas a pedidos"
      />

      <Alert color="blue" title="Onde a emissão acontece">
        A geração, assinatura e envio à SEFAZ vivem em
        <Code mx={4}>apps/integrations</Code>+ Cloud Functions, atrás do
        plugin <Code mx={4}>@delfrance/integrations-nfe</Code>. Esta tela é
        somente leitura: lista pedidos que já receberam chNFe da
        emissão. A configuração de numeração / série / certificado fica em
        <Anchor component={Link} href="/configuracoes" ml={4}>
          Configurações
        </Anchor>
        .
      </Alert>

      {error && <Alert color="red">{error.message}</Alert>}
      {loading && (
        <Stack>
          <Skeleton height={36} />
          <Skeleton height={36} />
        </Stack>
      )}
      {!loading && data && (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Pedido</Table.Th>
              <Table.Th>Estado</Table.Th>
              <Table.Th>Chaves NFe</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={4} align="center">
                  Nenhum pedido com NFe vinculada.
                </Table.Td>
              </Table.Tr>
            )}
            {data.map(({ id, data: p }) => (
              <Table.Tr key={id}>
                <Table.Td>
                  <Anchor component={Link} href={`/pedidos/${id}/editar`}>
                    {p.numero || `#${id.slice(0, 8)}`}
                  </Anchor>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {p.estado}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Stack gap={2}>
                    {(p.chNFeReferenciadas ?? []).map((ch) => (
                      <Code key={ch} fz={11}>
                        {ch}
                      </Code>
                    ))}
                  </Stack>
                </Table.Td>
                <Table.Td />
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
