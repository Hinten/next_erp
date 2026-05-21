'use client';

/**
 * Per-cell components for the Pedidos TableView's virtual columns.
 * Each component receives the bits it needs (the pedido or just its
 * id) and either reads passthrough fields synchronously OR subscribes
 * to a Firestore lookup (sibling subcollection, outer-ref dereference).
 *
 * Mirror the legacy Flutter cells in
 * `.old/lib/pedido/pages/pedidoTableView.dart:2074-2116`.
 */
import { useMemo } from 'react';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import {
  ESTADO_FRETE_LABELS,
  ESTADO_NFE,
  type EstadoNFe,
  type Pedido,
  pedidoTotal,
} from '@delfrance/schemas';
import { format, money } from '@delfrance/core/money';
import { Badge, Skeleton, Text, Tooltip } from '@mantine/core';

import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { nfeCollection } from '@/lib/data/nfeCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

const DASH = '—';

/**
 * Pretty-print a millisecond-since-epoch value as a Brazilian
 * date+time. Returns `DASH` when null/undefined.
 */
function formatMillis(ms: number | null | undefined): string {
  if (ms == null) return DASH;
  return new Date(ms).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* -------------------------------------------------------------------------- */
/*                                  NFCell                                    */
/*                                                                            */
/*  Subscribes to the latest doc in `pedidos/{pedidoId}/nfev4` (ordered by    */
/*  timestamp desc, limit 1) and renders a colored Badge per estado.          */
/* -------------------------------------------------------------------------- */

const NFE_STATE_BADGE: Partial<Record<EstadoNFe, { color: string; label: string }>> = {
  [ESTADO_NFE.aprovada]: { color: 'green', label: 'Aprovada' },
  [ESTADO_NFE.rejeitada]: { color: 'red', label: 'Rejeitada' },
  [ESTADO_NFE.enviando]: { color: 'yellow', label: 'Enviando' },
  [ESTADO_NFE.aguardandoResposta]: { color: 'yellow', label: 'Aguardando' },
  [ESTADO_NFE.gerado]: { color: 'gray', label: 'Gerada' },
  [ESTADO_NFE.cancelada]: { color: 'gray', label: 'Cancelada' },
  [ESTADO_NFE.error]: { color: 'red', label: 'Erro' },
};

export function NFCell({ pedidoId }: { pedidoId: string }) {
  const db = getFirebaseFirestore();
  const q = useMemo(() => {
    const base = nfeCollection.ref(db, { pedidoId });
    return buildQuery(base, [orderByField('timestamp', 'desc'), limit(1)]);
  }, [db, pedidoId]);
  const { data, loading } = useSnapshot(q);

  if (loading) return <Skeleton height={20} width={70} />;
  const latest = data?.[0]?.data;
  if (!latest) return <Text c="dimmed">{DASH}</Text>;
  const badge = NFE_STATE_BADGE[latest.estado];
  if (!badge) {
    return <Badge variant="light" color="gray">{latest.estado}</Badge>;
  }
  return <Badge variant="light" color={badge.color}>{badge.label}</Badge>;
}

/* -------------------------------------------------------------------------- */
/*                                ClienteCell                                 */
/*                                                                            */
/*  Dereferences pedido.clientePedidoOuterRef and renders cliente.nome.       */
/* -------------------------------------------------------------------------- */

export function ClienteCell({ pedido }: { pedido: Pedido }) {
  const db = getFirebaseFirestore();
  const ref = useMemo(
    () => dereferenceOuterRef(db, pedido.clientePedidoOuterRef),
    [db, pedido.clientePedidoOuterRef],
  );
  const { data, loading } = useDocSnapshot(ref);

  if (!ref) return <Text c="dimmed">Anônimo</Text>;
  if (loading) return <Skeleton height={20} width={120} />;
  const nome = (data?.data as { nome?: string } | undefined)?.nome;
  return <Text>{nome ?? 'Anônimo'}</Text>;
}

/* -------------------------------------------------------------------------- */
/*                                  VlrCell                                   */
/*                                                                            */
/*  Uses the cached `valorCobrado` if set; falls back to a fresh              */
/*  `pedidoTotal(pedido)` over the itens record.                              */
/* -------------------------------------------------------------------------- */

export function VlrCell({ pedido }: { pedido: Pedido }) {
  const value = pedido.valorCobrado ?? pedidoTotal(pedido);
  if (value === 0 && pedido.valorCobrado == null) {
    return <Text c="dimmed">{DASH}</Text>;
  }
  return <Text fw={500}>{format(money(Math.round(value * 100)))}</Text>;
}

/* -------------------------------------------------------------------------- */
/*                               ExpedicaoCell                                */
/*                                                                            */
/*  Reads pedido.freteInicial?.prazoDespacho (ms since epoch).                */
/* -------------------------------------------------------------------------- */

export function ExpedicaoCell({ pedido }: { pedido: Pedido }) {
  return <Text>{formatMillis(pedido.freteInicial?.prazoDespacho)}</Text>;
}

/* -------------------------------------------------------------------------- */
/*                                 FreteCell                                  */
/*                                                                            */
/*  Reads pedido.freteInicial?.estado (typed enum). Skip the click-for-       */
/*  history dialog from the legacy UX — that's a follow-up.                   */
/* -------------------------------------------------------------------------- */

export function FreteCell({ pedido }: { pedido: Pedido }) {
  const estado = pedido.freteInicial?.estado;
  if (!estado) return <Text c="dimmed">{DASH}</Text>;
  return <Text>{ESTADO_FRETE_LABELS[estado] ?? estado}</Text>;
}

/* -------------------------------------------------------------------------- */
/*                                CriacaoCell                                 */
/* -------------------------------------------------------------------------- */

export function CriacaoCell({ pedido }: { pedido: Pedido }) {
  return <Text>{formatMillis(pedido.timestamp)}</Text>;
}

/* -------------------------------------------------------------------------- */
/*                                  ImpCell                                   */
/*                                                                            */
/*  Renders a check icon (with the print timestamp in a Tooltip) when         */
/*  pedido.dtImpressao is non-null; empty otherwise.                          */
/* -------------------------------------------------------------------------- */

export function ImpCell({ pedido }: { pedido: Pedido }) {
  if (pedido.dtImpressao == null) return null;
  return (
    <Tooltip label={formatMillis(pedido.dtImpressao)}>
      <Text component="span" aria-label="Impresso" c="teal" fw={700}>
        ✓
      </Text>
    </Tooltip>
  );
}
