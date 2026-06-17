'use client';

import { useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { FirebaseError } from 'firebase/app';
import { setDoc } from 'firebase/firestore';
import { buildQuery, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import {
  FORMA_PAGAMENTO_LABELS,
  STATUS_PAGAMENTO,
  STATUS_PAGAMENTO_LABELS,
  type FormaPagamento,
  type Pagamento,
  type StatusPagamento,
} from '@delfrance/schemas';
import { format, money } from '@delfrance/core/money';
import { nowMicros } from '@delfrance/core/datetime';
import { pagamentoCollection } from '@/lib/data/pagamentoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { PagamentoStatusBadge } from '../../pagamentos/_components/StatusBadge';
import { gatewayIdFromTipo, getGateway } from '@/lib/plugins/paymentRegistry';

const statusOptions = (Object.values(STATUS_PAGAMENTO) as StatusPagamento[])
  .sort((a, b) => a - b)
  .map((value) => ({
    value: String(value),
    label: STATUS_PAGAMENTO_LABELS[value],
  }));

/**
 * Real-time list of pagamentos for a given pedido. Status can be edited
 * inline with admin override; refund actions resolve through the
 * PaymentGateway plugin registry — until Phase 5 wires concrete
 * gateways, the actions render as disabled with an explanatory tooltip.
 */
export function PagamentosSection({ pedidoId }: { pedidoId: string }) {
  const q = useMemo(() => {
    const base = pagamentoCollection.ref(getFirebaseFirestore(), { pedidoId });
    return buildQuery(base, [orderByField('dataCadastro', 'desc')]);
  }, [pedidoId]);

  const { data, loading, error } = useSnapshot<Pagamento>(q);

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={3}>Pagamentos</Title>
      </Group>
      {error && <Alert color="red">{error.message}</Alert>}
      {loading && <Skeleton height={64} />}
      {!loading && data && data.length === 0 && (
        <Text c="dimmed">Nenhum pagamento registrado neste pedido.</Text>
      )}
      {!loading && data && data.length > 0 && (
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Status</Table.Th>
              <Table.Th>Forma</Table.Th>
              <Table.Th align="right">Valor</Table.Th>
              <Table.Th align="right">Parcelas</Table.Th>
              <Table.Th>Ações</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.map(({ id, data: pgto }) => (
              <PagamentoRow key={id} pedidoId={pedidoId} id={id} pagamento={pgto} />
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function PagamentoRow({
  pedidoId,
  id,
  pagamento,
}: {
  pedidoId: string;
  id: string;
  pagamento: Pagamento;
}) {
  const [savingStatus, setSavingStatus] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);

  // Resolve a configured gateway for this pagamento (if its
  // metodoPagamentoOuterRef points at a known TIPO_INTEGRACAO_PGTO).
  // Today the registry has no implementations, so getGateway() returns
  // null and the refund button stays disabled with a tooltip.
  const ref = pagamento.metodoPagamentoOuterRef as { tipo?: number } | null | undefined;
  const gatewayId = ref?.tipo ? gatewayIdFromTipo(ref.tipo) : null;
  const gateway = gatewayId ? getGateway(gatewayId) : null;

  const docRef = pagamentoCollection.docRef(getFirebaseFirestore(), { pedidoId }, id);

  async function handleStatusChange(next: string | null) {
    if (next === null) return;
    const nextStatus = Number(next) as StatusPagamento;
    if (nextStatus === pagamento.status_pagamento) return;
    setSavingStatus(true);
    try {
      await setDoc(
        docRef,
        {
          status_pagamento: nextStatus,
          ultimaModificacao: nowMicros(),
        },
        { merge: true },
      );
    } finally {
      setSavingStatus(false);
    }
  }

  async function handleRefund() {
    if (!gateway || !pagamento.id) return;
    setRefunding(true);
    setRefundError(null);
    try {
      await gateway.refund(pagamento.id);
    } catch (err) {
      if (err instanceof FirebaseError) {
        setRefundError(err.message);
      } else {
        throw err;
      }
    } finally {
      setRefunding(false);
    }
  }

  return (
    <>
      <Table.Tr>
        <Table.Td>
          <Stack gap={4}>
            <PagamentoStatusBadge status={pagamento.status_pagamento ?? null} />
            <Select
              data={statusOptions}
              value={
                pagamento.status_pagamento !== undefined && pagamento.status_pagamento !== null
                  ? String(pagamento.status_pagamento)
                  : null
              }
              onChange={handleStatusChange}
              disabled={savingStatus}
              size="xs"
              w={220}
            />
          </Stack>
        </Table.Td>
        <Table.Td>
          {FORMA_PAGAMENTO_LABELS[pagamento.forma_de_pagamento as FormaPagamento] ?? '—'}
        </Table.Td>
        <Table.Td align="right">{format(money(Math.round(pagamento.valor * 100)))}</Table.Td>
        <Table.Td align="right">{pagamento.parcelas}</Table.Td>
        <Table.Td>
          <Group gap="xs">
            {gatewayId ? (
              <Badge variant="light" color="blue">
                {gatewayId}
              </Badge>
            ) : (
              <Badge variant="light" color="gray">
                gateway não vinculado
              </Badge>
            )}
            <Tooltip
              label={gateway ? 'Estorna via gateway' : 'Plugin de gateway não registrado (Fase 5)'}
            >
              <Button
                size="xs"
                variant="light"
                color="red"
                disabled={!gateway || !pagamento.id}
                loading={refunding}
                onClick={handleRefund}
              >
                Estornar
              </Button>
            </Tooltip>
          </Group>
        </Table.Td>
      </Table.Tr>
      {refundError && (
        <Table.Tr>
          <Table.Td colSpan={5}>
            <Alert color="red">{refundError}</Alert>
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}
