'use client';

import { useMemo } from 'react';
import { Alert, Card, Select, Skeleton, Stack, Text, Timeline, Title } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { Controller, type UseFormReturn } from 'react-hook-form';
import {
  ESTADO_PEDIDO,
  ESTADO_PEDIDO_LABELS,
  bloqueioFinalizarAtivo,
  type BloqueioPedido,
  type HistoricoEstadoPedido,
  type Pedido,
} from '@delfrance/schemas';
import { buildQuery, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { historicoEstadoCollection } from '@/lib/data/historicoEstadoCollection';
import type { PedidoFormState } from '../types';

const estadoOptions = (Object.entries(ESTADO_PEDIDO_LABELS) as [string, string][]).map(
  ([value, label]) => ({ value, label }),
);

/**
 * The estado options, with `finalizado` disabled while a marketplace dispute or
 * return is open (#1322).
 *
 * ⚠️ `finalizado` is the exact assertion an open claim contradicts: it means the
 * order has CONSOLIDATED — the return window has passed and the money is
 * certain. An open return IS that window, still open; an open mediation is the
 * money still being uncertain. Every other estado stays selectable, because the
 * operator may legitimately need to move a disputed pedido (to `cancelado`, for
 * one).
 *
 * Disabled rather than removed: an option that vanishes reads as a bug, while a
 * disabled one with a reason teaches what to do next.
 */
function buildEstadoOptions(motivo: string | null) {
  if (motivo === null) return estadoOptions;
  return estadoOptions.map((o) =>
    o.value === ESTADO_PEDIDO.finalizado
      ? { ...o, label: `${o.label} — ${motivo}`, disabled: true }
      : o,
  );
}

/** Format a µs-epoch stamp as a pt-BR date-time. */
function formatMicros(micros: number | null | undefined): string {
  if (micros == null) return '—';
  return new Date(Math.round(micros / 1000)).toLocaleString('pt-BR');
}

export interface EstadoHistoricoTabProps {
  form: UseFormReturn<PedidoFormState, unknown, Pedido>;
  disabled?: boolean;
  /** Absent in create mode — there is no history to read yet. */
  pedidoId?: string;
  /**
   * The pedido's marketplace dispute overlay (#1322). Absent in create mode —
   * a pedido that does not exist yet has no claims.
   */
  bloqueio?: BloqueioPedido;
}

export function EstadoHistoricoTab({
  form,
  disabled,
  pedidoId,
  bloqueio,
}: EstadoHistoricoTabProps) {
  const motivoFinalizar =
    bloqueio && bloqueioFinalizarAtivo(bloqueio)
      ? bloqueio.devolucaoAbertaEm != null
        ? 'devolução em andamento'
        : 'reclamação aberta'
      : null;
  return (
    <Stack>
      <Card withBorder>
        <Stack gap="xs">
          <Text fw={500}>Estado do pedido</Text>
          {motivoFinalizar !== null && (
            <Alert color="orange" icon={<IconAlertTriangle size={16} />}>
              Este pedido tem uma {motivoFinalizar} no marketplace, então ainda não pode ser
              finalizado — &quot;Finalizado&quot; significa que o prazo de devolução passou e o
              dinheiro é certo. Resolva a reclamação na aba Incidentes.
            </Alert>
          )}
          <Controller
            control={form.control}
            name="estado"
            render={({ field, fieldState }) => (
              <Select
                label="Estado"
                description="Alterar registra uma entrada no histórico ao salvar."
                data={buildEstadoOptions(motivoFinalizar)}
                value={field.value}
                onChange={(v) => v && field.onChange(v as PedidoFormState['estado'])}
                onBlur={field.onBlur}
                disabled={disabled}
                error={fieldState.error?.message}
                allowDeselect={false}
                w={320}
              />
            )}
          />
        </Stack>
      </Card>

      {pedidoId ? (
        <HistoricoList pedidoId={pedidoId} />
      ) : (
        <Text c="dimmed" size="sm">
          Salve o pedido para ver o histórico de estados.
        </Text>
      )}
    </Stack>
  );
}

function HistoricoList({ pedidoId }: { pedidoId: string }) {
  const q = useMemo(() => {
    const base = historicoEstadoCollection.ref(getFirebaseFirestore(), { pedidoId });
    return buildQuery(base, [orderByField('data', 'desc')]);
  }, [pedidoId]);
  const { data, loading, error } = useSnapshot<HistoricoEstadoPedido>(q);

  return (
    <Stack gap="xs">
      <Title order={4}>Histórico de estados</Title>
      {error && <Alert color="red">{error.message}</Alert>}
      {loading && <Skeleton height={64} />}
      {!loading && data && data.length === 0 && (
        <Text c="dimmed" size="sm">
          Nenhuma mudança de estado registrada.
        </Text>
      )}
      {!loading && data && data.length > 0 && (
        <Timeline active={data.length} bulletSize={14} lineWidth={2}>
          {data.map(({ id, data: h }) => (
            <Timeline.Item key={id} title={ESTADO_PEDIDO_LABELS[h.estado] ?? h.estado}>
              <Text size="xs" c="dimmed">
                {formatMicros(h.data)}
              </Text>
            </Timeline.Item>
          ))}
        </Timeline>
      )}
    </Stack>
  );
}
