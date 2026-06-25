'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
import { FirebaseError } from 'firebase/app';
import { PageHeader } from '@delfrance/ui';
import { useDocSnapshot } from '@delfrance/data/hooks';
import {
  buildPedidoPatch,
  PedidoConflictError,
  PedidoNothingChangedError,
  recordEstadoChange,
  savePedido,
} from '@delfrance/data/pedido';
import { valuesEqual, type Pedido } from '@delfrance/schemas';
import { useAuth } from '@/lib/auth/useAuth';
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

  // The pedido as first loaded — the concurrency baseline savePedido compares the
  // live Firestore doc against. Captured ONCE in an effect (useDocSnapshot is
  // real-time; reading it live at save time would defeat the guard). Refs are
  // touched in effects/handlers, never during render.
  const baselineRef = useRef<Record<string, unknown> | null>(null);
  useEffect(() => {
    const live = data?.data as Record<string, unknown> | undefined;
    if (!live) return;
    if (baselineRef.current === null) {
      // Shallow copy so the fold below can't mutate the live snapshot object.
      baselineRef.current = { ...live };
      return;
    }
    // The pagamento auto-reconcile (and any external write) can advance the
    // pedido's `estado` / `freteInicial` while the editor is open. Fold those
    // into the concurrency baseline so saving an unrelated field doesn't read
    // them as a conflict. (The form's estado field is synced in PedidoForm.)
    const b = baselineRef.current;
    if (!valuesEqual(b.estado, live.estado)) b.estado = live.estado;
    if (!valuesEqual(b.freteInicial, live.freteInicial)) b.freteInicial = live.freteInicial;
  }, [data]);

  const [emitConfirmOpen, setEmitConfirmOpen] = useState(false);
  const [emitting, setEmitting] = useState(false);
  const nfeClient = useNFeClient();
  const { user } = useAuth();

  // The conflict the snapshot guard tripped on. Holds the pending patch, the
  // baseline the user reviewed, and the remote doc so the modal can show the diff
  // and re-save against the reviewed version.
  const [conflict, setConflict] = useState<{
    patch: Record<string, unknown>;
    baseline: Record<string, unknown>;
    current: Record<string, unknown>;
  } | null>(null);
  const [savingConflict, setSavingConflict] = useState(false);

  // A manual estado change appends a historicoEstadoPedido audit row (legacy
  // `Pedido.save()` behavior) — only after the doc save committed it, and only
  // when it actually changed. Best-effort: the estado itself is already
  // persisted, so a failed audit-log write (e.g. a rules gap) must NOT block the
  // save/navigation — warn and move on.
  async function recordEstadoIfChanged(
    port: ReturnType<typeof createClientPedidoPort>,
    patch: Record<string, unknown>,
    prevEstado: unknown,
  ) {
    if (!('estado' in patch) || patch.estado === prevEstado) return;
    try {
      await recordEstadoChange(port, {
        pedidoId: params.id,
        estado: patch.estado as Pedido['estado'],
        usuarioRef: user ? `documents/usuarios/${user.uid}` : null,
      });
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({
          color: 'yellow',
          message: 'Estado salvo, mas o histórico não pôde ser registrado.',
        });
        return;
      }
      throw err;
    }
  }

  async function handleSubmit(
    values: Pedido,
    dirtyFields: Readonly<Record<string, unknown>>,
    opts: { continueEditing: boolean },
  ): Promise<boolean> {
    // Partial save: write only the touched fields, guarded against concurrent
    // edits by comparing the live doc to the snapshot loaded into the editor.
    const baseline = baselineRef.current ?? (values as unknown as Record<string, unknown>);
    const patch = buildPedidoPatch(values, dirtyFields);
    const port = createClientPedidoPort(getFirebaseFirestore());
    try {
      await savePedido(port, { pedidoId: params.id, patch, baseline });
      await recordEstadoIfChanged(port, patch, baseline.estado);
      if (opts.continueEditing) {
        // "Salvar e continuar editando": stay on this page (no navigation, so the
        // unsaved-changes guard never prompts). Re-baseline the concurrency guard
        // to the just-saved state; the live `useDocSnapshot` keeps the page data
        // fresh and PedidoForm re-baselines the form to pristine.
        baselineRef.current = { ...baseline, ...patch };
        notifications.show({ color: 'green', message: 'Pedido salvo.' });
        return true;
      }
      router.replace('/pedidos');
      return true;
    } catch (err) {
      if (err instanceof PedidoNothingChangedError) {
        notifications.show({ color: 'yellow', message: err.message });
        return false;
      }
      if (err instanceof PedidoConflictError) {
        // Doc changed remotely → let the user review + decide (modal). Doc deleted
        // (`current` null) → nothing to overwrite, just a toast.
        if (err.current) {
          setConflict({ patch, baseline, current: err.current });
        } else {
          showErrorNotification({ title: 'Pedido alterado', message: err.message });
        }
        return false;
      }
      throw err;
    }
  }

  // "Salvar mesmo assim": override the version the user JUST reviewed — re-save
  // with the baseline set to that remote snapshot, NOT a blind force. If the doc
  // changed AGAIN since the modal opened, the guard re-trips and we re-open the
  // modal with the newer diff, so an unreviewed edit is never clobbered.
  async function handleForceSave() {
    if (!conflict) return;
    setSavingConflict(true);
    const port = createClientPedidoPort(getFirebaseFirestore());
    try {
      await savePedido(port, {
        pedidoId: params.id,
        patch: conflict.patch,
        baseline: conflict.current,
      });
      await recordEstadoIfChanged(port, conflict.patch, conflict.current.estado);
      setConflict(null);
      router.replace('/pedidos');
    } catch (err) {
      if (err instanceof PedidoConflictError) {
        if (err.current) {
          // Changed again since the modal opened — re-review the newer version.
          setConflict({ patch: conflict.patch, baseline: conflict.current, current: err.current });
        } else {
          showErrorNotification({ title: 'Pedido alterado', message: err.message });
          setConflict(null);
        }
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
    // Fill the AppShell main area so the form's flex layout can pin the sticky
    // footer to the bottom regardless of how short a tab's content is.
    <Stack mih="calc(100dvh - var(--app-shell-header-height, 56px) - var(--app-shell-padding, 1rem) * 2)">
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
        fields={conflict ? conflictFields(conflict.baseline, conflict.current, conflict.patch) : []}
        saving={savingConflict}
        onForceSave={handleForceSave}
        onCancel={() => setConflict(null)}
      />

      <PedidoForm
        defaultValues={p}
        pedidoId={data.id}
        submitLabel="Salvar alterações"
        liveEstado={p.estado}
        onSubmit={handleSubmit}
      />
    </Stack>
  );
}
