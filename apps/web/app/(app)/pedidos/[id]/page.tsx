'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { setDoc } from 'firebase/firestore';
import {
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  Select,
  Skeleton,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PageHeader } from '@delfrance/ui';
import { useDocSnapshot } from '@delfrance/data/hooks';
import {
  ESTADO_PEDIDO_LABELS,
  type EstadoPedido,
  estadoPedidoSchema,
  pedidoTotal,
} from '@delfrance/schemas';
import { format, money } from '@delfrance/core/money';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useNFeClient } from '@/lib/nfe/client';
import {
  notificationForNFeError,
  notificationForNFeResult,
} from '@/lib/nfe/errors';
import { StatusBadge } from '../_components/StatusBadge';
import { ItensTable } from '../_components/ItensTable';
import { PagamentosSection } from '../_components/PagamentosSection';

const estadoOptions = estadoPedidoSchema.options.map((value) => ({
  value,
  label: ESTADO_PEDIDO_LABELS[value],
}));

export default function PedidoDetailPage() {
  const params = useParams<{ id: string }>();

  const docRef = useMemo(
    () => pedidoCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);
  const [savingStatus, setSavingStatus] = useState(false);
  const [emittingNFe, setEmittingNFe] = useState(false);
  const nfeClient = useNFeClient();

  if (loading) {
    return (
      <Stack>
        <Skeleton height={32} width={240} />
        <Skeleton height={200} />
      </Stack>
    );
  }

  if (error) return <Alert color="red">{error.message}</Alert>;
  if (!data) {
    return (
      <Stack>
        <Alert color="yellow">Pedido não encontrado.</Alert>
        <Anchor component={Link} href="/pedidos">
          Voltar
        </Anchor>
      </Stack>
    );
  }

  const p = data.data;
  const pedidoId = data.id;
  const itensFlat = Object.entries(p.itens).flatMap(([, list]) =>
    list.map((item, i) => ({
      ...item,
      ordem: item.ordem ?? i + 1,
    })),
  );
  itensFlat.sort((a, b) => a.ordem - b.ordem);
  const total = pedidoTotal(p);

  async function handleStatusChange(next: string | null) {
    if (!next) return;
    const nextState = next as EstadoPedido;
    if (nextState === p.estado) return;
    setSavingStatus(true);
    try {
      await setDoc(docRef, { estado: nextState }, { merge: true });
    } finally {
      setSavingStatus(false);
    }
  }

  async function handleEmitirNFe() {
    if (!nfeClient) return;
    setEmittingNFe(true);
    try {
      const result = await nfeClient.emitir(pedidoId);
      notifications.show({ ...notificationForNFeResult(result), autoClose: 8000 });
    } catch (err) {
      // Non-Error throws are programming bugs (e.g. `throw 'string'`) —
      // re-throw so they surface as uncaught rejections.
      // notificationForNFeError narrows by instanceof per typed
      // subclass (NFeRejectedError, NFeBlockedError, …).
      if (!(err instanceof Error)) throw err;
      notifications.show({ ...notificationForNFeError(err), autoClose: 8000 });
    } finally {
      setEmittingNFe(false);
    }
  }

  const blocked = p.bloquearEmissaoNFe === true;
  const emitirButton = (
    <Button
      onClick={handleEmitirNFe}
      loading={emittingNFe}
      disabled={blocked || !nfeClient}
      variant="filled"
      color="teal"
    >
      Emitir NF-e
    </Button>
  );

  return (
    <Stack>
      <PageHeader
        title={
          <Group align="center">
            <Title order={2}>{p.numero || `#${data.id.slice(0, 6)}`}</Title>
            <StatusBadge estado={p.estado} />
          </Group>
        }
        description={p.ehSaida ? 'Saída' : 'Entrada'}
        actions={
          <Group gap="xs">
            {blocked ? (
              <Tooltip label="Emissão de NF-e bloqueada para este pedido (bloquearEmissaoNFe)">
                <span>{emitirButton}</span>
              </Tooltip>
            ) : (
              emitirButton
            )}
            <Button component={Link} href={`/pedidos/${data.id}/editar`}>
              Editar
            </Button>
          </Group>
        }
      />

      <Card withBorder>
        <Stack gap="xs">
          <Group justify="space-between">
            <Text c="dimmed" size="sm">
              Status
            </Text>
            <Select
              data={estadoOptions}
              value={p.estado}
              onChange={handleStatusChange}
              disabled={savingStatus}
              w={280}
              searchable
            />
          </Group>
          <Group justify="space-between">
            <Text c="dimmed" size="sm">
              Total
            </Text>
            <Text fw={700}>{format(money(Math.round(total * 100)))}</Text>
          </Group>
          <Group justify="space-between">
            <Text c="dimmed" size="sm">
              Itens
            </Text>
            <Text>{itensFlat.length}</Text>
          </Group>
        </Stack>
      </Card>

      <Title order={3}>Itens</Title>
      <ItensTable itens={itensFlat} />

      <PagamentosSection pedidoId={data.id} />

      <Anchor component={Link} href="/pedidos" size="sm">
        ← Voltar ao quadro
      </Anchor>
    </Stack>
  );
}
