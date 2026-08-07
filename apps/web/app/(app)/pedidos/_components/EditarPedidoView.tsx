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
import { PageHeader } from '@delfrance/ui';
import { useDocSnapshot } from '@delfrance/data/hooks';
import {
  buildPedidoPatch,
  novosOriginsDeTroca,
  PedidoConflictError,
  PedidoNothingChangedError,
  savePedido,
} from '@delfrance/data/pedido';
import type { Pedido } from '@delfrance/schemas';
import { PedidoForm } from './PedidoForm';
import { PedidoConflictModal } from './PedidoConflictModal';
import { conflictFields } from './conflictFields';
import { createClientPedidoPort } from '@/lib/pedidos/clientPort';
import { marcarInteracaoDoUsuario } from '@/lib/pedidos/interacaoDoUsuario';
import { StatusBadge } from './StatusBadge';
import { DIRECAO, direcaoOf } from './direcao';
import { DirecaoBadge } from './DirecaoBadge';
import { DirecaoSurface } from './DirecaoSurface';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useEmitirEntradaPrompt } from './useEmitirEntradaPrompt';
import { emitirNFeComNotificacao } from './emitirNFeComNotificacao';
import { registrarIncidentesDeTrocaBestEffort } from './trocaIncidentesBestEffort';
import { useNFeClient } from '@/lib/nfe/client';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';

/**
 * The edit-pedido page, shared by `/pedidos/[id]/editar` and
 * `/pedidos/entradas/[id]/editar`. Takes NO direcao prop: the direction is
 * derived from the loaded doc's `ehSaida` (authoritative — the flag is
 * immutable on an existing pedido), so a saída opened under the entradas
 * route still behaves as a saída and vice versa.
 */
export function EditarPedidoView() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const docRef = useMemo(
    () => pedidoCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);

  // Direction of the loaded doc (defaults to saída while loading — handlers
  // only run after the snapshot lands, so `cfg` is correct at call time).
  const direcao = direcaoOf(data?.data?.ehSaida);
  const cfg = DIRECAO[direcao];

  // The pedido as first loaded — the concurrency baseline savePedido compares the
  // live Firestore doc against. Captured ONCE in an effect (useDocSnapshot is
  // real-time; reading it live at save time would defeat the guard). Refs are
  // touched in effects/handlers, never during render.
  const baselineRef = useRef<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (baselineRef.current === null && data?.data) {
      baselineRef.current = data.data as Record<string, unknown>;
    }
  }, [data]);

  const [emitConfirmOpen, setEmitConfirmOpen] = useState(false);
  const [emitting, setEmitting] = useState(false);
  const nfeClient = useNFeClient();

  const { promptEmitirEntrada, element: emitirEntradaPromptElement } = useEmitirEntradaPrompt();

  // The conflict the snapshot guard tripped on. Holds the pending patch, the
  // baseline the user reviewed, and the remote doc so the modal can show the diff
  // and re-save against the reviewed version.
  const [conflict, setConflict] = useState<{
    patch: Record<string, unknown>;
    baseline: Record<string, unknown>;
    current: Record<string, unknown>;
  } | null>(null);
  const [savingConflict, setSavingConflict] = useState(false);

  // #488 re-save gate: a saída save whose `itensDevolvidos` gained NEW origin
  // pedidos writes a troca incidente on each of them — and nothing else (no
  // devolução pedido, no dialogs on re-save). Best-effort: the pedido is
  // already saved, so a failed incidente write must not block the flow.
  async function registrarTrocaIncidentesIfNeeded(
    port: ReturnType<typeof createClientPedidoPort>,
    patch: Record<string, unknown>,
    preSave: Record<string, unknown>,
  ) {
    if (direcao !== 'saida' || !('itensDevolvidos' in patch)) return;
    const originIds = novosOriginsDeTroca(
      preSave.itensDevolvidos as Pedido['itensDevolvidos'],
      patch.itensDevolvidos as Pedido['itensDevolvidos'],
    );
    if (originIds.length === 0) return;
    const numero = data?.data?.numero;
    await registrarIncidentesDeTrocaBestEffort(port, {
      saidaPedidoId: params.id,
      saidaNumero: typeof numero === 'string' ? numero : null,
      originIds,
    });
  }

  // #551: a paid entrada may prompt to emit its NF-e right after the save
  // (eligibility checks + the dialog live in the hook).
  async function promptEmitirIfEntradaPaga(
    patch: Record<string, unknown>,
    preSave: Record<string, unknown>,
  ) {
    if (direcao !== 'entrada') return;
    await promptEmitirEntrada({
      pedidoId: params.id,
      estado: 'estado' in patch ? patch.estado : preSave.estado,
      operacaoOuterRef:
        'operacaoPedidoOuterRef' in patch
          ? patch.operacaoPedidoOuterRef
          : preSave.operacaoPedidoOuterRef,
    });
  }

  async function handleSubmit(
    values: Pedido,
    dirtyFields: Readonly<Record<string, unknown>>,
    opts: { continueEditing: boolean },
  ): Promise<boolean> {
    // Partial save: write only the touched fields, guarded against concurrent
    // edits by comparing the live doc to the snapshot loaded into the editor.
    const loaded = baselineRef.current ?? (values as unknown as Record<string, unknown>);
    // The pagamento auto-reconcile advances `estado` / `freteInicial` in Firestore
    // while the editor is open. For a field the user is NOT saving, refresh the
    // concurrency baseline to the live snapshot so that auto-change doesn't read
    // as a conflict — while a real concurrent edit to a field the user IS saving
    // still trips the F3 guard.
    const live = (data?.data as Record<string, unknown> | undefined) ?? loaded;
    const baseline: Record<string, unknown> = { ...loaded };
    if (!dirtyFields.estado) baseline.estado = live.estado;
    if (!dirtyFields.freteInicial) baseline.freteInicial = live.freteInicial;
    // Mark the pedido as human-touched (see `marcarInteracaoDoUsuario`). It rides
    // in the patch — rather than being appended by the port — so the "salvar e
    // continuar editando" re-baseline below picks it up and the next save doesn't
    // read it as a remote change.
    const patch = marcarInteracaoDoUsuario(buildPedidoPatch(values, dirtyFields));
    const port = createClientPedidoPort(getFirebaseFirestore());
    try {
      // An estado change is recorded in `historicoEstadoPedido` by the
      // `onPedidoEstadoChanged` Cloud Function, which observes this very write —
      // nothing to append from here.
      await savePedido(port, { pedidoId: params.id, patch, baseline });
      await registrarTrocaIncidentesIfNeeded(port, patch, loaded);
      await promptEmitirIfEntradaPaga(patch, baseline);
      if (opts.continueEditing) {
        // "Salvar e continuar editando": stay on this page (no navigation, so the
        // unsaved-changes guard never prompts). Re-baseline the concurrency guard
        // to the just-saved state; the live `useDocSnapshot` keeps the page data
        // fresh and PedidoForm re-baselines the form to pristine.
        baselineRef.current = { ...baseline, ...patch };
        notifications.show({ color: 'green', message: cfg.savedToast });
        return true;
      }
      router.replace(cfg.listPath);
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
      // As in handleSubmit: an estado change is recorded in historicoEstadoPedido
      // by the `onPedidoEstadoChanged` Cloud Function observing this write.
      await savePedido(port, {
        pedidoId: params.id,
        patch: conflict.patch,
        baseline: conflict.current,
      });
      await registrarTrocaIncidentesIfNeeded(port, conflict.patch, conflict.current);
      await promptEmitirIfEntradaPaga(conflict.patch, conflict.current);
      setConflict(null);
      router.replace(cfg.listPath);
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
    setEmitting(true);
    try {
      // Shared post-commit emission: null-client toast, copyable success +
      // error toasts.
      await emitirNFeComNotificacao(nfeClient, params.id);
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
    <DirecaoSurface direcao={direcao}>
      {/* Fill the AppShell main area so the form's flex layout can pin the
          sticky footer to the bottom regardless of how short a tab's content
          is. */}
      <Stack mih="calc(100dvh - var(--app-shell-header-height, 56px) - var(--app-shell-padding, 1rem) * 2)">
        <PageHeader
          title={
            <Group align="center">
              <Title order={2}>
                {cfg.docLabel} {p.numero || 'Sem número'}
              </Title>
              <StatusBadge estado={p.estado} />
              <DirecaoBadge direcao={direcao} />
            </Group>
          }
          description={cfg.docLabel}
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
              <Anchor component={Link} href={cfg.listPath} size="sm">
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

        <PedidoConflictModal
          opened={!!conflict}
          fields={
            conflict ? conflictFields(conflict.baseline, conflict.current, conflict.patch) : []
          }
          saving={savingConflict}
          onForceSave={handleForceSave}
          onCancel={() => setConflict(null)}
        />

        {emitirEntradaPromptElement}

        <PedidoForm
          defaultValues={p}
          pedidoId={data.id}
          submitLabel="Salvar alterações"
          liveEstado={p.estado}
          onSubmit={handleSubmit}
        />
      </Stack>
    </DirecaoSurface>
  );
}
