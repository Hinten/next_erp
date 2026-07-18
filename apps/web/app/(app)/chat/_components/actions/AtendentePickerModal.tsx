'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Group, Loader, Modal, Select, Stack, Text } from '@mantine/core';
import { FirebaseError } from 'firebase/app';
import { getDocs } from 'firebase/firestore';
import { buildQuery, limit, orderByField, whereOp } from '@delfrance/data';
import { usuarioCollection } from '@/lib/data/usuarioCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import type { ActionActor } from '@/lib/chat/conversaActions';

/**
 * Atendente picker used by both "Transferir" and "Incluir atendente". Lists the
 * eligible atendentes and returns the chosen one as an {@link ActionActor}.
 *
 * ── Atendente filter (decision) ────────────────────────────────────────────────
 * Legacy `_transferirConversaDialog`/`_incluirConversaDialog`
 * (`.old/lib/chat/basico/conversa_popup_menu.dart:188,256`) query
 * `Usuario.documents.colaborador__isEqualTo(true)`. This repo's `usuarioSchema`
 * carries that exact boolean (`colaborador`), so we reuse it: an atendente is a
 * `usuarios` doc with `colaborador === true`. That also excludes the sem-auth
 * external-channel contacts (WhatsApp/Facebook end customers), which never carry
 * `colaborador: true`. The display label is the usuario `nome` (legacy
 * `Usuario.displayName`).
 */
async function fetchAtendentes(): Promise<ActionActor[]> {
  const db = getFirebaseFirestore();
  const snap = await getDocs(
    buildQuery(usuarioCollection.ref(db, {}), [
      whereOp('colaborador', '==', true),
      orderByField('nome', 'asc'),
      limit(200),
    ]),
  );
  return snap.docs.map((d) => ({ uid: d.id, displayName: d.data().nome }));
}

/**
 * Drop the excluded uids from the atendente list. "Transferir" excludes only the
 * operator (`[uid]`); "Incluir" also excludes the current participants
 * (`[uid, ...usuarios]`) so re-including an already-present atendente — which
 * would append a duplicate "entrou na conversa." event — is not offered.
 */
export function filterAtendentes(
  list: ActionActor[],
  excludeUids: ReadonlyArray<string | null | undefined>,
): ActionActor[] {
  const exclude = new Set(excludeUids.filter((u): u is string => !!u));
  return list.filter((a) => !exclude.has(a.uid));
}

export function AtendentePickerModal({
  opened,
  onClose,
  title,
  confirmLabel,
  submitting,
  excludeUids,
  onConfirm,
}: {
  opened: boolean;
  onClose: () => void;
  title: string;
  confirmLabel: string;
  submitting: boolean;
  /** Hide these uids from the list (the operator themselves, and/or existing participants). */
  excludeUids?: ReadonlyArray<string | null | undefined>;
  onConfirm: (target: ActionActor) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  // A selection must not survive close/reopen — a stale pick would leave the
  // confirm button armed and invite an accidental transfer/include.
  useEffect(() => {
    if (!opened) setSelected(null);
  }, [opened]);

  const { data, isFetching, error } = useQuery({
    queryKey: ['atendentes'],
    queryFn: fetchAtendentes,
    enabled: opened,
    staleTime: 60_000,
  });

  const atendentes = filterAtendentes(data ?? [], excludeUids ?? []);
  const options = atendentes.map((a) => ({ value: a.uid, label: a.displayName }));
  const chosen = atendentes.find((a) => a.uid === selected) ?? null;

  return (
    <Modal opened={opened} onClose={() => !submitting && onClose()} title={title} size="sm">
      <Stack gap="md">
        {error instanceof FirebaseError && (
          <Alert color="red">Erro ao carregar atendentes: {error.message}</Alert>
        )}
        {isFetching ? (
          <Text c="dimmed" size="sm" ta="center">
            <Loader size="xs" /> Carregando atendentes…
          </Text>
        ) : (
          <Select
            data-autofocus
            label="Atendente"
            placeholder="Selecione um atendente"
            data={options}
            value={selected}
            onChange={setSelected}
            searchable
            nothingFoundMessage="Nenhum atendente"
            comboboxProps={{ withinPortal: true }}
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button
            loading={submitting}
            disabled={!chosen}
            onClick={() => chosen && onConfirm(chosen)}
          >
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
