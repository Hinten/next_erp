'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Loader, Modal, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { FirebaseError } from 'firebase/app';
import { getDocs } from 'firebase/firestore';
import { buildQuery, limit, orderByField, whereOp } from '@delfrance/data';
import { formatTelefone, telefoneQueryShapes } from '@delfrance/core/phone';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/** Firestore prefix-range upper sentinel. */
const PREFIX_MAX = String.fromCharCode(0xffff);

interface ClienteHit {
  id: string;
  nome: string;
  telefone: string | null;
}

/**
 * `documents/clientes/<id>` — the value `conversa.clienteOuterRef` carries, and
 * therefore the value the inbox filter matches on.
 *
 * This replaces the old `userCliente` → `usarioOuterRef` hop. That hop is why a
 * cliente with no linked `usuarios` doc used to be unselectable — which is now
 * the NORMAL case, since a marketplace buyer never logs in and #768 stopped
 * minting a usuario per contact.
 */
function clienteOuterRefFor(clienteId: string): string {
  return `documents/clientes/${clienteId}`;
}

async function searchClientes(term: string): Promise<ClienteHit[]> {
  const db = getFirebaseFirestore();
  const trimmed = term.trim();
  const digits = trimmed.replace(/\D/g, '');
  const isPhone = digits.length >= 3 && digits === trimmed;

  const constraints = isPhone
    ? (() => {
        const shapes = telefoneQueryShapes(trimmed);
        return shapes.length > 0 ? [whereOp('telefone', 'in', shapes), limit(15)] : null;
      })()
    : [
        whereOp('nome', '>=', trimmed),
        whereOp('nome', '<', `${trimmed}${PREFIX_MAX}`),
        orderByField('nome', 'asc'),
        limit(15),
      ];

  if (!constraints) return [];

  const snap = await getDocs(buildQuery(clienteCollection.ref(db, {}), constraints));
  return snap.docs.map((d) => {
    const c = d.data();
    return {
      id: d.id,
      nome: c.nome ?? '(sem nome)',
      telefone: c.telefone,
    };
  });
}

/**
 * Cliente search modal for the inbox "Cliente" filter: a small prefix search on
 * `nome` (or exact `telefone` when the term is all digits), using the existing
 * query builders (no vector search).
 *
 * Picking a cliente emits `documents/clientes/<id>` — the value
 * `conversa.clienteOuterRef` carries — and EVERY hit is selectable. The old
 * version resolved the cliente's linked `usuarios` doc and disabled any cliente
 * without one; after #768 that describes every marketplace buyer, who never logs
 * in and no longer gets a synthetic usuario. Disabling them hid exactly the
 * customers this filter is most useful for.
 */
export function ClientePickerModal({
  opened,
  onClose,
  onSelect,
}: {
  opened: boolean;
  onClose: () => void;
  onSelect: (clienteRef: string, nome: string) => void;
}) {
  const [term, setTerm] = useState('');
  const enabled = opened && term.trim().length >= 2;

  const { data, isFetching, error } = useQuery({
    queryKey: ['clientePicker', term.trim()],
    queryFn: () => searchClientes(term),
    enabled,
    staleTime: 30_000,
  });

  return (
    <Modal opened={opened} onClose={onClose} title="Filtrar por cliente" size="md">
      <Stack gap="sm">
        <TextInput
          data-autofocus
          placeholder="Nome ou telefone…"
          value={term}
          onChange={(e) => setTerm(e.currentTarget.value)}
        />

        {error instanceof FirebaseError && (
          <Alert color="red">Erro na busca: {error.message}</Alert>
        )}

        {enabled && isFetching && (
          <Text c="dimmed" size="sm" ta="center">
            <Loader size="xs" /> Buscando…
          </Text>
        )}

        {enabled && !isFetching && (data?.length ?? 0) === 0 && (
          <Text c="dimmed" size="sm" ta="center" py="sm">
            Nenhum cliente encontrado.
          </Text>
        )}

        <Stack gap={2}>
          {data?.map((hit) => (
            <UnstyledButton
              key={hit.id}
              onClick={() => {
                onSelect(clienteOuterRefFor(hit.id), hit.nome);
                onClose();
              }}
              p="xs"
              style={(theme) => ({
                borderRadius: theme.radius.sm,
                cursor: 'pointer',
              })}
            >
              <Text size="sm" fw={500} lineClamp={1}>
                {hit.nome}
              </Text>
              <Text size="xs" c="dimmed">
                {hit.telefone ? formatTelefone(hit.telefone) : 'sem telefone'}
              </Text>
            </UnstyledButton>
          ))}
        </Stack>
      </Stack>
    </Modal>
  );
}
