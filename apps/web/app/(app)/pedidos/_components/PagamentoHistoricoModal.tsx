'use client';

import { useMemo } from 'react';
import { Alert, Modal, Skeleton, Table, Text } from '@mantine/core';
import { STATUS_PAGAMENTO_LABELS, type HistPgto, type StatusPagamento } from '@delfrance/schemas';
import { buildQuery, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { histPgtoCollection } from '@/lib/data/histPgtoCollection';

/** Format a ms-epoch stamp as a pt-BR date-time. */
function formatMillis(millis: number | null | undefined): string {
  if (millis == null) return '—';
  return new Date(millis).toLocaleString('pt-BR');
}

function statusLabel(status: StatusPagamento | null): string {
  return status == null ? '—' : (STATUS_PAGAMENTO_LABELS[status] ?? String(status));
}

/**
 * Read-only status-change history dialog for one pagamento — port of the
 * legacy `historicoPagamentoWidget.dart` (a tappable chip opening a table of
 * Estado Atual / Estado Anterior / Data, newest-first). Rows come exclusively
 * from the `onPagamentoStatusChanged` trigger (#369); this component only reads.
 */
export function PagamentoHistoricoModal({
  pedidoId,
  pagamentoId,
  opened,
  onClose,
}: {
  pedidoId: string;
  pagamentoId: string;
  opened: boolean;
  onClose: () => void;
}) {
  const q = useMemo(() => {
    const base = histPgtoCollection.ref(getFirebaseFirestore(), { pedidoId, pagamentoId });
    return buildQuery(base, [orderByField('timestamp', 'desc')]);
  }, [pedidoId, pagamentoId]);
  // Only subscribe while the modal is open — no point paying for a listener
  // on every row of a long pagamento list.
  const { data, loading, error } = useSnapshot<HistPgto>(opened ? q : null);

  return (
    <Modal opened={opened} onClose={onClose} title="Histórico do pagamento" centered size="lg">
      {error && <Alert color="red">{error.message}</Alert>}
      {loading && <Skeleton height={64} />}
      {!loading && data && data.length === 0 && (
        <Text c="dimmed" size="sm">
          Nenhuma mudança de status registrada.
        </Text>
      )}
      {!loading && data && data.length > 0 && (
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Estado Atual</Table.Th>
              <Table.Th>Estado Anterior</Table.Th>
              <Table.Th>Data</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.map(({ id, data: h }) => (
              <Table.Tr key={id}>
                <Table.Td>{statusLabel(h.status_atual)}</Table.Td>
                <Table.Td>{statusLabel(h.status_anterior)}</Table.Td>
                <Table.Td>{formatMillis(h.timestamp)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Modal>
  );
}
