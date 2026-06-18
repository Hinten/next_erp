'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
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
import {
  buildPedidoPatch,
  PedidoConflictError,
  PedidoNothingChangedError,
  savePedido,
} from '@delfrance/data/pedido';
import type { Pedido } from '@delfrance/schemas';
import { PedidoForm } from '../../_components/PedidoForm';
import { PedidoConflictModal } from '../../_components/PedidoConflictModal';
import { conflictFields } from '../../_components/conflictFields';
import { createClientPedidoPort } from '@/lib/pedidos/clientPort';
import { StatusBadge } from '../../_components/StatusBadge';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useNFeClient } from '@/lib/nfe/client';
import { notificationForNFeError, notificationForNFeResult } from '@/lib/nfe/errors';
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

  // The conflict the optimistic-concurrency guard tripped on. Holds the pending
  // patch + the remote doc so the modal can show the diff and re-save with force.
  const [conflict, setConflict] = useState<{
    patch: Record<string, unknown>;
    current: Record<string, unknown>;
  } | null>(null);
  const [savingConflict, setSavingConflict] = useState(false);

  async function handleSubmit(values: Pedido, dirtyFields: Readonly<Record<string, unknown>>) {
    // Partial save: write only the touched fields (never the whole doc), guarded
    // against concurrent edits. The form never mutates `ultimaModificacao` (no
    // input binds to it), so `values.ultimaModificacao` is still the value the
    // doc was loaded with — the optimistic-concurrency base.
    const patch = buildPedidoPatch(values, dirtyFields);
    try {
      await savePedido(createClientPedidoPort(getFirebaseFirestore()), {
        pedidoId: params.id,
        patch,
        baseUltimaModificacao: values.ultimaModificacao ?? null,
      });
      router.replace('/pedidos');
    } catch (err) {
      if (err instanceof PedidoNothingChangedError) {
        notifications.show({ color: 'yellow', message: err.message });
        return;
      }
      if (err instanceof PedidoConflictError) {
        // Doc edited by someone else → let the user review + decide (modal). Doc
        // deleted (`current` null) → nothing to overwrite, just a toast.
        if (err.current) {
          setConflict({ patch, current: err.current });
        } else {
          showErrorNotification({ title: 'Pedido alterado', message: err.message });
        }
        return;
      }
      throw err;
    }
  }

  // "Salvar mesmo assim": re-run the same patch bypassing the guard.
  async function handleForceSave() {
    if (!conflict) return;
    setSavingConflict(true);
    try {
      await savePedido(createClientPedidoPort(getFirebaseFirestore()), {
        pedidoId: params.id,
        patch: conflict.patch,
        baseUltimaModificacao: null, // ignored under force
        force: true,
      });
      setConflict(null);
      router.replace('/pedidos');
    } catch (err) {
      // The only conflict left under force is a deleted doc (current null).
      if (err instanceof PedidoConflictError) {
        showErrorNotification({ title: 'Pedido alterado', message: err.message });
        setConflict(null);
        return;
      }
      throw err;
    } finally {
      setSavingConflict(false);
    }
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
            <Button variant="subtle" onClick={() => setEmitConfirmOpen(false)} disabled={emitting}>
              Cancelar
            </Button>
            <Button color="teal" onClick={handleEmitir} loading={emitting}>
              Confirmar
            </Button>
          </Group>
        </Stack>
      </Modal>

      <PedidoConflictModal
        opened={!!conflict}
        fields={conflict ? conflictFields(conflict.patch, conflict.current) : []}
        saving={savingConflict}
        onForceSave={handleForceSave}
        onCancel={() => setConflict(null)}
      />

      <PedidoForm
        defaultValues={p}
        pedidoId={data.id}
        submitLabel="Salvar alterações"
        onSubmit={handleSubmit}
      />
    </Stack>
  );
}
