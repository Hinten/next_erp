'use client';

import { Badge, type MantineColor } from '@mantine/core';
import {
  STATUS_PAGAMENTO,
  STATUS_PAGAMENTO_LABELS,
  type StatusPagamento,
} from '@delfrance/schemas';

const COLOR: Record<StatusPagamento, MantineColor> = {
  [STATUS_PAGAMENTO.pendente]: 'gray',
  [STATUS_PAGAMENTO.em_revisao]: 'yellow',
  [STATUS_PAGAMENTO.pago_parcialmente]: 'yellow',
  [STATUS_PAGAMENTO.em_processo_aprovacao]: 'yellow',
  [STATUS_PAGAMENTO.aprovado]: 'green',
  [STATUS_PAGAMENTO.em_disputa]: 'orange',
  [STATUS_PAGAMENTO.recusado]: 'red',
  [STATUS_PAGAMENTO.cancelado]: 'red',
  [STATUS_PAGAMENTO.estornado]: 'red',
  [STATUS_PAGAMENTO.devolvido]: 'red',
  [STATUS_PAGAMENTO.estornado_parcialmente]: 'orange',
  [STATUS_PAGAMENTO.estornado_totalmente]: 'red',
};

export function PagamentoStatusBadge({ status }: { status: StatusPagamento | null | undefined }) {
  if (status === null || status === undefined) {
    return (
      <Badge color="gray" variant="light">
        Sem status
      </Badge>
    );
  }
  return (
    <Badge color={COLOR[status]} variant="light" radius="sm">
      {STATUS_PAGAMENTO_LABELS[status]}
    </Badge>
  );
}
