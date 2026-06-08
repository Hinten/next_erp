'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Alert, Anchor, Skeleton, Stack, Table, Text } from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import { buildQuery, defineCollection, groupQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import {
  FORMA_PAGAMENTO_LABELS,
  type FormaPagamento,
  type Pagamento,
  pagamentoSchema,
} from '@delfrance/schemas';
import { format, money } from '@delfrance/core/money';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { PagamentoStatusBadge } from './_components/StatusBadge';

const PAGE_SIZE = 100;

// We need a converter for collection-group reads. Reuse defineCollection's
// converter — its `path` is irrelevant here, but the converter we get back
// validates with the same `pagamentoSchema` as direct subcollection reads.
const converterHandle = defineCollection({
  path: 'pedidos/_/pagamentos',
  schema: pagamentoSchema,
});

/**
 * Recover the pedido id from the full doc path `pedidos/<pedidoId>/pagamentos/<id>`.
 * Returns null when the path doesn't match the expected shape (would
 * happen if a third app starts writing pagamentos under a different
 * parent, which today doesn't happen).
 */
function pedidoIdFromPath(path: string): string | null {
  const parts = path.split('/');
  if (parts[0] !== 'pedidos' || parts.length < 4) return null;
  return parts[1] ?? null;
}

export default function PagamentosListPage() {
  const q = useMemo(() => {
    const base = groupQuery(getFirebaseFirestore(), 'pagamentos', converterHandle.converter);
    return buildQuery(base, [orderByField('dataCadastro', 'desc'), limit(PAGE_SIZE)]);
  }, []);

  const { data, loading, error } = useSnapshot<Pagamento>(q);

  return (
    <Stack>
      <PageHeader
        title="Pagamentos"
        description="Últimos pagamentos em todos os pedidos (collection-group)"
      />

      {error && (
        <Alert color="red" title="Erro ao carregar pagamentos">
          {error.message}
          <Text size="xs" mt={4}>
            Pode ser necessário criar um índice composto no Firestore — o console mostra o link na
            primeira execução.
          </Text>
        </Alert>
      )}

      {loading && (
        <Stack>
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
        </Stack>
      )}

      {!loading && data && (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Pedido</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Forma</Table.Th>
              <Table.Th align="right">Valor</Table.Th>
              <Table.Th align="right">Parcelas</Table.Th>
              <Table.Th>Cadastro</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={6} align="center">
                  Nenhum pagamento encontrado.
                </Table.Td>
              </Table.Tr>
            )}
            {data.map(({ id, path, data: pgto }) => {
              const pedidoId = pedidoIdFromPath(path);
              const formattedValor = format(money(Math.round(pgto.valor * 100)));
              const formaLabel = FORMA_PAGAMENTO_LABELS[pgto.forma_de_pagamento as FormaPagamento];
              return (
                <Table.Tr key={path}>
                  <Table.Td>
                    {pedidoId ? (
                      <Anchor component={Link} href={`/pedidos/${pedidoId}/editar`}>
                        #{pedidoId.slice(0, 8)}
                      </Anchor>
                    ) : (
                      <Text c="dimmed">—</Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <PagamentoStatusBadge status={pgto.status_pagamento ?? null} />
                  </Table.Td>
                  <Table.Td>{formaLabel}</Table.Td>
                  <Table.Td align="right">{formattedValor}</Table.Td>
                  <Table.Td align="right">{pgto.parcelas}</Table.Td>
                  <Table.Td>
                    {pgto.dataCadastro
                      ? new Date(pgto.dataCadastro).toLocaleDateString('pt-BR')
                      : '—'}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
