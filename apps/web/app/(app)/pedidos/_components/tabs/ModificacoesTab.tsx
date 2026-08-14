'use client';

import { useMemo } from 'react';
import { Alert, Stack, Text } from '@mantine/core';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import {
  ESTADO_PEDIDO_LABELS,
  type HistoricoEstadoPedido,
  historicoEstadoPedidoMeta,
} from '@delfrance/schemas';

/** Matches `historicoEstadoPedidoMeta.defaultQuery.limit` — the indexed page. */
const ESTADO_PAGE_SIZE = historicoEstadoPedidoMeta.defaultQuery?.limit ?? 50;
import { ModificacaoHistoryFeed, type ListEntry } from '@/components/ModificacaoHistoryFeed';
import { historicoEstadoCollection } from '@/lib/data/historicoEstadoCollection';
import { historicoModificacoesPedidoCollection } from '@/lib/data/historicoModificacoesPedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/**
 * "Modificações" tab — the pedido's full edit history in one chronological
 * feed: the pedido document itself plus its `pagamentos` and `incidentes`, all
 * recorded by the server-owned trigger family, so every writer is covered (the
 * editor, the Mercado Livre import, the Mercado Pago webhook, and the legacy
 * Flutter app).
 *
 * READ-ONLY by design. The produto feed offers per-field "Restaurar"; a pedido
 * does not, because reverting a field behind the triggers' backs would have to
 * reason about stock reservation, fiscal state (an invoiced pedido), payment
 * reconciliation and the estado machine. Passing no `renderFieldActions` is what
 * enforces that — there is no flag to flip by accident.
 *
 * ⚠️ The legacy estado rows are interleaved, but only the ones this collection
 * does not already cover — see {@link legacyEstadoEntries}.
 */

/** The pedido document itself has no `subcolecao`; its children name themselves. */
const SUBCOLECAO_LABELS: Record<string, string> = {
  '': 'Pedido',
  pagamentos: 'Pagamento',
  incidentes: 'Incidente',
};

export interface ModificacoesTabProps {
  /** Absent in create mode — there is no history to read yet. */
  pedidoId?: string;
}

export function ModificacoesTab({ pedidoId }: ModificacoesTabProps) {
  if (!pedidoId) {
    return (
      <Text c="dimmed" size="sm">
        Salve o pedido para ver o histórico de modificações.
      </Text>
    );
  }
  return <ModificacoesFeed pedidoId={pedidoId} />;
}

function ModificacoesFeed({ pedidoId }: { pedidoId: string }) {
  const db = getFirebaseFirestore();

  // The pre-trigger estado trail — same sort and page size the collection's
  // `defaultQuery` declares, which is what the indexed query is.
  const estadoQuery = useMemo(
    () =>
      buildQuery(historicoEstadoCollection.ref(db, { pedidoId }), [
        orderByField('data', 'desc'),
        limit(ESTADO_PAGE_SIZE),
      ]),
    [db, pedidoId],
  );
  const estado = useSnapshot<HistoricoEstadoPedido>(estadoQuery);

  const extraEntries = useMemo(
    () => legacyEstadoEntries(estado.data ?? [], pedidoId),
    [estado.data, pedidoId],
  );

  return (
    <Stack gap="md">
      {estado.error && (
        <Alert color="yellow">
          O histórico de estados anterior não pôde ser carregado ({estado.error.code}); as
          modificações abaixo continuam completas.
        </Alert>
      )}
      <ModificacaoHistoryFeed
        db={db}
        collection={historicoModificacoesPedidoCollection}
        ctx={{ pedidoId }}
        subcolecaoLabels={SUBCOLECAO_LABELS}
        emptyLabel="Nenhuma modificação registrada."
        extraEntries={extraEntries}
      />
    </Stack>
  );
}

/**
 * Map the LEGACY `historicoEstadoPedido` rows into feed entries.
 *
 * ⚠️ Only rows with no `eventId` are taken, and that filter is the whole point.
 * Since the modification trigger shipped, an estado change is recorded as an
 * ordinary field of the pedido document, and BOTH rows are keyed on the same
 * CloudEvent id — so replaying the full trail would show every post-deploy
 * transition twice. A `null` `eventId` means "written before the trigger
 * existed" (the schema says so explicitly), which is exactly the set the
 * modification history cannot cover and the only set worth interleaving.
 *
 * These are display-only projections: `old` is unknown (the legacy row stored
 * only the new state), so the change renders as `— → <estado>` rather than
 * inventing a previous value.
 */
export function legacyEstadoEntries(
  rows: ReadonlyArray<{ id: string; data: HistoricoEstadoPedido }>,
  pedidoId: string,
): ListEntry[] {
  return rows
    .filter((row) => row.data.eventId == null)
    .map((row) => ({
      id: `estado-legado:${row.id}`,
      path: `pedidos/${pedidoId}`,
      subcolecao: null,
      docId: pedidoId,
      kind: 'update' as const,
      campos: ['estado'],
      timestamp: row.data.data ?? null,
      changes: {
        estado: {
          old: null,
          new: ESTADO_PEDIDO_LABELS[row.data.estado] ?? row.data.estado,
        },
      },
      // The legacy trail DID record an actor, under its own field name.
      usuarioOuterRef: row.data.usuarioHistoricoEstadosPedidoOuterRef,
    }));
}
