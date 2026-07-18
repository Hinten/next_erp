'use client';

import { useState } from 'react';
import { Button, Checkbox, Group, Modal, Paper, Select, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { FirebaseError } from 'firebase/app';
import { writeBatch } from 'firebase/firestore';
import { ESTADO_CONVERSA, ESTADO_CONVERSA_LABELS, type EstadoConversa } from '@delfrance/schemas';
import { conversaCollection } from '@/lib/data/conversaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { writeEvent } from '@/lib/chat/writeEvent';
import { useAuth } from '@/lib/auth';
import { EtiquetaPicker } from './EtiquetaPicker';

const estadoOptions = (Object.values(ESTADO_CONVERSA) as EstadoConversa[])
  .sort((a, b) => a - b)
  .map((value) => ({ value: String(value), label: ESTADO_CONVERSA_LABELS[value] }));

/**
 * Bulk-action bar for the selected conversas (legacy `acaoEmMassa`,
 * `.old/lib/chat/menu_lateral.dart:312-349` + `alterarEstadoEmMassa` in the
 * provider): change the estado and/or set an etiqueta across the selection,
 * confirmed first. Each affected conversa gets a merge patch
 * (`estadoConversa?` / `cor_etiqueta?` + a bumped `ultima_modificacao`) plus an
 * EVENT mensagem (`tipo: 'e'`) — an event never triggers the outbound sender
 * (the #529 trigger excludes `tipo 'e'`), so `mid` is written `null` purely for
 * consistency with the pipeline's `writeEvent` shape.
 */
export function BulkActionsBar({
  selectedIds,
  onApplied,
}: {
  selectedIds: string[];
  onApplied: () => void;
}) {
  const { user } = useAuth();
  const [estado, setEstado] = useState<string | null>(null);
  const [alterarCor, setAlterarCor] = useState(false);
  const [cor, setCor] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);

  const count = selectedIds.length;
  const hasAction = estado !== null || alterarCor;
  const displayName = user?.displayName ?? user?.email ?? 'Operador';
  // Legacy `alterarEstadoEmMassa` passed `user: authProvider.usuario` to BOTH
  // event constructors, so each bulk event carries the operator's ref too.
  const actor = user?.uid ? { uid: user.uid } : null;

  async function apply() {
    const db = getFirebaseFirestore();
    const now = Date.now();
    const estadoNum = estado !== null ? (Number(estado) as EstadoConversa) : null;

    // A WriteBatch caps at 500 ops; each conversa costs up to 3 (patch + up to
    // 2 events), so "select all" on a 200-row page can exceed it. Chunk the
    // selection so each batch stays comfortably under the ceiling. Chunks
    // commit independently (a mid-sequence failure leaves earlier chunks
    // applied — same non-atomicity legacy's bulk update had).
    const OPS_PER_CONVERSA = 3;
    const CHUNK = Math.floor(450 / OPS_PER_CONVERSA);
    const batches = [];
    for (let i = 0; i < selectedIds.length; i += CHUNK) {
      const batch = writeBatch(db);
      for (const conversaId of selectedIds.slice(i, i + CHUNK)) {
        // Merge patch WITHOUT the converter: the schema fills every field with a
        // default on parse, so a converted merge would clobber untouched fields
        // (nome/origem/…). Strip the converter to write only the intended keys.
        const patch: Record<string, unknown> = { ultima_modificacao: now };
        if (estadoNum !== null) patch.estadoConversa = estadoNum;
        if (alterarCor) patch.cor_etiqueta = cor;
        batch.set(conversaCollection.docRef(db, {}, conversaId).withConverter(null), patch, {
          merge: true,
        });

        // One event mensagem per action (legacy wrote estado + cor separately).
        if (estadoNum !== null) {
          writeEvent(
            batch,
            db,
            conversaId,
            `${displayName} alterou o estado da conversa para ${ESTADO_CONVERSA_LABELS[estadoNum]}.`,
            now,
            actor,
          );
        }
        if (alterarCor) {
          writeEvent(batch, db, conversaId, `${displayName} definiu a etiqueta.`, now, actor);
        }
      }
      batches.push(batch);
    }

    try {
      for (const batch of batches) await batch.commit();
      notifications.show({
        color: 'teal',
        title: 'Alterações aplicadas',
        message: `${count} ${count === 1 ? 'conversa atualizada' : 'conversas atualizadas'}.`,
      });
      setConfirming(false);
      setEstado(null);
      setAlterarCor(false);
      setCor(null);
      onApplied();
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({ color: 'red', title: 'Falha ao aplicar', message: err.message });
      } else {
        throw err;
      }
    } finally {
      setApplying(false);
    }
  }

  return (
    <Paper withBorder p="xs" radius="sm" bg="var(--mantine-color-gray-0)">
      <Stack gap="xs">
        <Text size="xs" fw={600}>
          {count} {count === 1 ? 'selecionada' : 'selecionadas'}
        </Text>
        <Select
          size="xs"
          placeholder="Alterar estado…"
          data={estadoOptions}
          value={estado}
          onChange={setEstado}
          clearable
          comboboxProps={{ withinPortal: true }}
        />
        <Checkbox
          size="xs"
          label="Alterar etiqueta"
          checked={alterarCor}
          onChange={(e) => setAlterarCor(e.currentTarget.checked)}
        />
        {alterarCor && <EtiquetaPicker value={cor} onChange={setCor} />}
        <Button size="xs" disabled={!hasAction || count === 0} onClick={() => setConfirming(true)}>
          Aplicar
        </Button>
      </Stack>

      <Modal
        opened={confirming}
        onClose={() => !applying && setConfirming(false)}
        title="Confirmar alterações"
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">
            {count === 1
              ? '1 conversa foi selecionada, deseja continuar?'
              : `${count} conversas foram selecionadas, deseja continuar?`}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirming(false)} disabled={applying}>
              Cancelar
            </Button>
            <Button
              color="blue"
              loading={applying}
              onClick={() => {
                setApplying(true);
                void apply();
              }}
            >
              Confirmar
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}
