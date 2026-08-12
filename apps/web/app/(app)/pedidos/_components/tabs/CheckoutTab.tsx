'use client';

import { useMemo } from 'react';
import { Alert, Badge, Card, Group, Skeleton, Stack, Text } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { type Firestore } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import {
  ESTADO_FRETE_LABELS,
  MODALIDADE_FRETE_LABELS,
  type CheckoutFretePedido,
  type FreteDoPedido,
  type ItemCheckoutPedido,
} from '@delfrance/schemas';
import { formatReais } from '@delfrance/core/money';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';
import { checkoutCollection } from '@/lib/data/checkoutCollection';
import { usuarioCollection } from '@/lib/data/usuarioCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { usePermission } from '@/lib/auth';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/** Format a ms-epoch stamp as a pt-BR date-time (`itemCheckoutPedidoSchema` /
 * `checkoutFretePedidoSchema` use MILLISECONDS, unlike the µs project default —
 * see the schema doc comment). */
function formatMillis(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString('pt-BR');
}

export interface CheckoutTabProps {
  /** Absent in create mode — there is no checkout to read yet. */
  pedidoId?: string;
}

/**
 * Read-only port of the legacy `CheckoutVisualizacaoWidget`
 * (`.old/lib/pedido/widgets/checkout_visualizacao.dart`) — the dispatch audit
 * doc a warehouse operator writes when finishing scanning a paid pedido's
 * physical contents. Nothing here is editable; the doc is written by the
 * despacho checkout flow (`apps/web/app/(app)/despacho/checkout`).
 */
export function CheckoutTab({ pedidoId }: CheckoutTabProps) {
  if (!pedidoId) {
    return (
      <Text c="dimmed" size="sm">
        Checkout não disponível — salve o pedido primeiro.
      </Text>
    );
  }
  return <CheckoutViewer pedidoId={pedidoId} />;
}

function CheckoutViewer({ pedidoId }: { pedidoId: string }) {
  const db = useMemo(() => getFirebaseFirestore(), []);
  // Legacy fetches the checkout doc with `.first()`, no ordering — it assumes
  // at most one checkout per pedido (`_save` throws if one already exists).
  // Order desc so a stray duplicate (shouldn't happen) shows the newest.
  const q = useMemo(
    () =>
      buildQuery(checkoutCollection.ref(db, { pedidoId }), [
        orderByField('timestamp', 'desc'),
        limit(1),
      ]),
    [db, pedidoId],
  );
  const { data, loading, error } = useSnapshot<CheckoutFretePedido>(q);
  const checkout = data?.[0]?.data ?? null;

  if (error) return <Alert color="red">{error.message}</Alert>;
  if (loading) return <Skeleton height={160} />;
  if (!checkout) {
    return (
      <Text c="dimmed" size="sm">
        Nenhum checkout realizado.
      </Text>
    );
  }

  return (
    <Stack>
      <Card withBorder>
        <Group gap="xs" wrap="nowrap">
          <IconCheck size={20} color="var(--mantine-color-green-6)" />
          <Stack gap={0}>
            <Text fw={500}>{checkout.title ?? 'Checkout'}</Text>
            <Text size="xs" c="dimmed">
              {formatMillis(checkout.timestamp)}
            </Text>
          </Stack>
        </Group>
      </Card>

      <ResponsavelCard outerRef={checkout.usuarioCheckoutFretePedidoOuterRef} db={db} />

      <ItensCheckoutCard itens={checkout.itensCheckout} db={db} />

      <FreteSnapshotCard frete={checkout.freteNoMomentoDoCheckout} />

      {checkout.obs && (
        <Card withBorder>
          <Text fw={500} mb="xs">
            Observações
          </Text>
          <Text size="sm">{checkout.obs}</Text>
        </Card>
      )}
    </Stack>
  );
}

/** Responsible user — gated behind the same permission as the `usuarios`
 * collection (legacy `UsuarioPerms().read`). */
function ResponsavelCard({ outerRef, db }: { outerRef: string; db: Firestore }) {
  const { allowed, loading: permLoading } = usePermission(PERM.configuracoes.read);
  const ref = useMemo(() => dereferenceOuterRef(db, outerRef), [db, outerRef]);
  const docRef = useMemo(
    () => (ref && allowed ? usuarioCollection.docRef(db, {}, ref.id) : null),
    [db, ref, allowed],
  );
  const { data: usuarioDoc, loading } = useDocSnapshot(docRef);

  return (
    <Card withBorder>
      <Text fw={500} mb="xs">
        Responsável
      </Text>
      {permLoading && <Skeleton height={20} />}
      {!permLoading && !allowed && (
        <Text size="sm" c="dimmed">
          Sem permissão para ver o usuário responsável.
        </Text>
      )}
      {!permLoading && allowed && loading && <Skeleton height={20} />}
      {!permLoading && allowed && !loading && (
        <Text size="sm">{usuarioDoc?.data.nome ?? usuarioDoc?.data.email ?? ref?.id ?? '—'}</Text>
      )}
    </Card>
  );
}

function ItensCheckoutCard({ itens, db }: { itens: ItemCheckoutPedido[] | null; db: Firestore }) {
  return (
    <Card withBorder>
      <Text fw={500} mb="xs">
        Itens
      </Text>
      {(!itens || itens.length === 0) && (
        <Text size="sm" c="dimmed">
          Nenhum item lançado.
        </Text>
      )}
      {itens && itens.length > 0 && (
        <Stack gap="xs">
          {itens.map((item, i) => (
            // Checkout items have no stable id of their own (a plain embedded
            // array, no doc ids) — index is the only key available.
            <ItemCheckoutRow key={i} item={item} db={db} />
          ))}
        </Stack>
      )}
    </Card>
  );
}

function ItemCheckoutRow({ item, db }: { item: ItemCheckoutPedido; db: Firestore }) {
  const ref = useMemo(
    () => dereferenceOuterRef(db, item.produtoCheckoutPedidoOuterRef),
    [db, item.produtoCheckoutPedidoOuterRef],
  );
  const docRef = useMemo(() => (ref ? produtoCollection.docRef(db, {}, ref.id) : null), [db, ref]);
  const { data: produtoDoc, loading } = useDocSnapshot(docRef);
  const isExcluded = item.dataExclusao != null;
  const hasError = !!item.error;

  return (
    <Group justify="space-between" wrap="nowrap" style={{ opacity: isExcluded ? 0.5 : 1 }}>
      <Stack gap={0}>
        <Group gap="xs">
          <Text size="sm" c={hasError ? 'red' : undefined}>
            {loading ? '…' : (produtoDoc?.data.nome ?? ref?.id ?? '—')}
          </Text>
          {produtoDoc?.data.sku && (
            <Text size="xs" c="dimmed">
              {produtoDoc.data.sku}
            </Text>
          )}
        </Group>
        <Text size="xs" c="dimmed">
          {formatMillis(item.timestamp)}
        </Text>
        {hasError && (
          <Text size="xs" c="red">
            {item.error}
          </Text>
        )}
        {isExcluded && (
          <Text size="xs" c="dimmed">
            Excluído em {formatMillis(item.dataExclusao)}
          </Text>
        )}
      </Stack>
      <Badge variant="light">{item.quantidade}×</Badge>
    </Group>
  );
}

function FreteSnapshotCard({ frete }: { frete: FreteDoPedido }) {
  return (
    <Card withBorder>
      <Text fw={500} mb="xs">
        Frete no momento do checkout
      </Text>
      <Group gap="xs" mb="xs">
        <Badge variant="light">
          {MODALIDADE_FRETE_LABELS[frete.modalidade] ?? frete.modalidade}
        </Badge>
        <Badge variant="light" color="gray">
          {ESTADO_FRETE_LABELS[frete.estado] ?? frete.estado}
        </Badge>
      </Group>
      {frete.valorCobrado != null && (
        <Text size="sm">Valor cobrado: {formatReais(frete.valorCobrado)}</Text>
      )}
      {frete.codRastreio && <Text size="sm">Código de rastreio: {frete.codRastreio}</Text>}
      {frete.volumes && frete.volumes.length > 0 && (
        <Stack gap={4} mt="xs">
          <Text size="sm" fw={500}>
            Volumes
          </Text>
          {frete.volumes.map((v, i) => (
            <Text key={i} size="xs" c="dimmed">
              {v.quantidade ?? 1}× — {v.pesoBruto != null ? `${v.pesoBruto} kg` : 'peso —'}
              {v.dimensoes
                ? ` — ${v.dimensoes.altura}×${v.dimensoes.largura}×${v.dimensoes.comprimento} cm`
                : ''}
            </Text>
          ))}
        </Stack>
      )}
    </Card>
  );
}
