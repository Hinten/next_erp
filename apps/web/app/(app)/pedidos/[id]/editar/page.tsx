'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { setDoc } from 'firebase/firestore';
import {
  Alert,
  Anchor,
  Button,
  Group,
  Modal,
  Skeleton,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PageHeader } from '@delfrance/ui';
import { useDocSnapshot } from '@delfrance/data/hooks';
import type { Pedido } from '@delfrance/schemas';
import { PedidoForm } from '../../_components/PedidoForm';
import { StatusBadge } from '../../_components/StatusBadge';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useNFeClient } from '@/lib/nfe/client';
import {
  notificationForNFeError,
  notificationForNFeResult,
} from '@/lib/nfe/errors';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';

export default function EditarPedidoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const docRef = useMemo(
    () => pedidoCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);

  const [emitConfirmOpen, setEmitConfirmOpen] = useState(false);
  const [emitting, setEmitting] = useState(false);
  const nfeClient = useNFeClient();

  async function handleSubmit(values: Pedido) {
    await setDoc(docRef, values, { merge: true });
    router.replace('/pedidos');
  }

  async function handleEmitir() {
    if (!nfeClient) {
      showErrorNotification({
        title: 'Você não está logado',
        message: 'Faça login para emitir NF-e.',
      });
      return;
    }
    setEmitting(true);
    try {
      const result = await nfeClient.emitir(params.id);
      notifications.show({
        ...notificationForNFeResult(result),
        autoClose: 8000,
      });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      showErrorNotification(notificationForNFeError(err));
    } finally {
      setEmitting(false);
      setEmitConfirmOpen(false);
    }
  }

  if (loading) {
    return (
      <Stack>
        <Skeleton height={32} width={240} />
        <Skeleton height={400} />
      </Stack>
    );
  }
  if (error) return <Alert color="red">{error.message}</Alert>;
  if (!data) return <Alert color="yellow">Pedido não encontrado.</Alert>;

  const p = data.data;

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
            <Tooltip
              label="Emissão de NF-e bloqueada para este pedido"
              disabled={!p.bloquearEmissaoNFe}
              withArrow
            >
              <Button
                color="teal"
                onClick={() => setEmitConfirmOpen(true)}
                disabled={!!p.bloquearEmissaoNFe || !nfeClient}
                loading={emitting}
              >
                Emitir NF-e
              </Button>
            </Tooltip>
            <Anchor component={Link} href="/pedidos" size="sm">
              Cancelar
            </Anchor>
          </Group>
        }
      />

      <Modal
        opened={emitConfirmOpen}
        onClose={() => setEmitConfirmOpen(false)}
        title="Emitir NF-e"
        centered
      >
        <Stack>
          <Text>Emitir NF-e para este pedido?</Text>
          <Group justify="flex-end">
            <Button
              variant="subtle"
              onClick={() => setEmitConfirmOpen(false)}
              disabled={emitting}
            >
              Cancelar
            </Button>
            <Button color="teal" onClick={handleEmitir} loading={emitting}>
              Confirmar
            </Button>
          </Group>
        </Stack>
      </Modal>

      <PedidoForm
        defaultValues={p}
        pedidoId={data.id}
        submitLabel="Salvar alterações"
        onSubmit={handleSubmit}
      />
    </Stack>
  );
}
