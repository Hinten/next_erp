'use client';

import { useState } from 'react';
import { Button, Group, Modal, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowBackUp } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import { ZodError } from 'zod';
import {
  ModificacaoHistoryFeed,
  renderValue,
  type ListEntry,
} from '@/components/ModificacaoHistoryFeed';
import { historicoModificacoesCollection } from '@/lib/data/historicoModificacoesCollection';
import { applyRevert, checkRevert, isRevertible, type RevertTarget } from '@/lib/produtos/revert';

/**
 * "Modificações" tab — the produto's unified `historicoDeModificacoes` feed with
 * per-field revert ("Restaurar") for a whitelist of safe fields
 * (`@/lib/produtos/revert`).
 *
 * The feed itself (live page 1 + cursor tail, expand, actor rendering) lives in
 * the shared `ModificacaoHistoryFeed`, which the pedido tab reuses. This wrapper
 * owns ONLY what is produto-specific: the revert path and its conflict modal.
 * `create`/`delete` entries stay display-only — v1 reverts a field-level
 * `update` change and nothing else.
 */

interface ConflictState {
  entryId: string;
  field: string;
  target: RevertTarget;
  currentValue: unknown;
}

/** The produto document itself has no `subcolecao`; its subdocs name themselves. */
const SUBCOLECAO_LABELS: Record<string, string> = {
  '': 'Produto',
  extraData: 'SEO/Marketing',
  imposto: 'Imposto',
};

export interface ModificacoesManagerProps {
  db: Firestore;
  produtoId: string;
}

export function ModificacoesManager({ db, produtoId }: ModificacoesManagerProps) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function finishRestaurar(target: RevertTarget) {
    await applyRevert(db, target);
    notifications.show({ color: 'teal', message: `Campo "${target.field}" restaurado.` });
    // A new history entry is written server-side by the trigger — the live
    // `onSnapshot` surfaces it; no manual refresh.
  }

  async function handleRestaurar(
    entry: ListEntry,
    field: string,
    change: { old: unknown; new: unknown },
  ) {
    const target: RevertTarget = {
      produtoId,
      subcolecao: entry.subcolecao,
      docId: entry.docId,
      field,
      oldValue: change.old,
      newValue: change.new,
    };
    setPendingKey(`${entry.id}:${field}`);
    try {
      const { conflict: hasConflict, currentValue } = await checkRevert(db, target);
      if (hasConflict) {
        setConflict({ entryId: entry.id, field, target, currentValue });
        return;
      }
      await finishRestaurar(target);
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({ color: 'red', title: 'Falha ao restaurar', message: err.message });
        return;
      }
      // `merge()` re-validates the patch (`parseMergePatch`); an old value that
      // no longer fits the CURRENT schema (schema evolution, or a legacy
      // Flutter-written field outside it) surfaces here instead of silently
      // rejecting the write.
      if (err instanceof ZodError) {
        notifications.show({
          color: 'red',
          title: 'Falha ao restaurar',
          message: 'Não foi possível restaurar: o valor antigo é incompatível com o esquema atual.',
        });
        return;
      }
      throw err;
    } finally {
      setPendingKey(null);
    }
  }

  async function handleConfirmConflict() {
    if (!conflict) return;
    setConfirming(true);
    try {
      await finishRestaurar(conflict.target);
      setConflict(null);
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({ color: 'red', title: 'Falha ao restaurar', message: err.message });
        return;
      }
      // Same schema-evolution surface as `handleRestaurar`'s catch.
      if (err instanceof ZodError) {
        notifications.show({
          color: 'red',
          title: 'Falha ao restaurar',
          message: 'Não foi possível restaurar: o valor antigo é incompatível com o esquema atual.',
        });
        return;
      }
      throw err;
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Stack gap="md">
      <ModificacaoHistoryFeed
        db={db}
        collection={historicoModificacoesCollection}
        ctx={{ produtoId }}
        subcolecaoLabels={SUBCOLECAO_LABELS}
        renderFieldActions={(entry, field, change) => (
          <RestaurarAction
            entry={entry}
            field={field}
            change={change}
            pending={pendingKey === `${entry.id}:${field}`}
            onRestaurar={() => void handleRestaurar(entry, field, change)}
          />
        )}
      />
      <Modal
        opened={conflict !== null}
        onClose={() => setConflict(null)}
        title="Valor mudou desde a modificação"
        centered
      >
        {conflict && (
          <Stack gap="xs">
            <Text size="sm">
              O campo <strong>{conflict.field}</strong> foi alterado novamente desde este registro.
            </Text>
            <Text size="sm">
              Valor que esta ação restauraria: {renderValue(conflict.target.oldValue)}
            </Text>
            <Text size="sm">Valor atual: {renderValue(conflict.currentValue)}</Text>
            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={() => setConflict(null)} disabled={confirming}>
                Cancelar
              </Button>
              <Button color="red" onClick={() => void handleConfirmConflict()} loading={confirming}>
                Restaurar mesmo assim
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

interface RestaurarActionProps {
  entry: ListEntry;
  field: string;
  change: { old: unknown; new: unknown };
  pending: boolean;
  onRestaurar: () => void;
}

function RestaurarAction({ entry, field, change, pending, onRestaurar }: RestaurarActionProps) {
  // Only a field-level UPDATE is revertible; a create/delete would need
  // document-level restore, which is a separate feature (#648).
  if (entry.kind !== 'update') return null;

  const gate = isRevertible(entry.subcolecao, field, change);
  const isPrecosOnParent = entry.subcolecao === null && field === 'precos';

  if (!gate.ok) {
    return (
      <Tooltip label={gate.reason ?? undefined}>
        <Button
          size="xs"
          variant="light"
          color="gray"
          disabled
          leftSection={<IconArrowBackUp size={14} />}
          aria-label={`Restaurar ${field}`}
          title={gate.reason ?? undefined}
        >
          Restaurar
        </Button>
      </Tooltip>
    );
  }

  return (
    <>
      <Button
        size="xs"
        variant="light"
        leftSection={<IconArrowBackUp size={14} />}
        loading={pending}
        onClick={onRestaurar}
        aria-label={`Restaurar ${field}`}
      >
        Restaurar
      </Button>
      {isPrecosOnParent && (
        <Text size="xs" c="orange">
          Restaurar o preço gera uma nova entrada de histórico e propaga para as variações.
        </Text>
      )}
    </>
  );
}
