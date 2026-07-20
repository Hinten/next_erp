'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Loader, Modal, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { FirebaseError } from 'firebase/app';
import { getDocs } from 'firebase/firestore';
import { buildQuery, limit, orderByField, whereOp } from '@delfrance/data';
import { telefoneQueryShapes } from '@delfrance/core/phone';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/** Firestore prefix-range upper sentinel. */
const PREFIX_MAX = String.fromCharCode(0xffff);

interface ClienteHit {
  id: string;
  nome: string;
  telefone: string | null;
  /** Resolved to `usarioOuterRef` form; null when the cliente has no linked user. */
  usarioRef: string | null;
}

/**
 * Canonicalize a `cliente.userCliente` (which may be stored bare or with the
 * `documents/` prefix) to the `usarioOuterRef` doc-path the conversa carries
 * (`documents/<col>/<id>`, see `packages/schemas/src/shared/outerRef.ts`), so a
 * `whereEqual('usarioOuterRef', …)` matches.
 */
function normalizeUsarioRef(userCliente: string): string {
  return `documents/${userCliente.replace(/^documents\//, '')}`;
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
      usarioRef: c.userCliente ? normalizeUsarioRef(c.userCliente) : null,
    };
  });
}

/**
 * Cliente search modal for the inbox "Cliente" filter: a small prefix search on
 * `nome` (or exact `telefone` when the term is all digits), using the existing
 * query builders (no vector search). Picking a cliente resolves its linked
 * `usuarios` doc → the `usarioOuterRef` the conversa filter matches. Clientes
 * with no linked user can't narrow the list, so they are shown disabled.
 */
export function ClientePickerModal({
  opened,
  onClose,
  onSelect,
}: {
  opened: boolean;
  onClose: () => void;
  onSelect: (usarioRef: string, nome: string) => void;
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
              disabled={!hit.usarioRef}
              onClick={() => {
                if (!hit.usarioRef) return;
                onSelect(hit.usarioRef, hit.nome);
                onClose();
              }}
              p="xs"
              style={(theme) => ({
                borderRadius: theme.radius.sm,
                opacity: hit.usarioRef ? 1 : 0.5,
                cursor: hit.usarioRef ? 'pointer' : 'not-allowed',
              })}
            >
              <Text size="sm" fw={500} lineClamp={1}>
                {hit.nome}
              </Text>
              <Text size="xs" c="dimmed">
                {hit.telefone ?? 'sem telefone'}
                {!hit.usarioRef && ' · sem usuário vinculado'}
              </Text>
            </UnstyledButton>
          ))}
        </Stack>
      </Stack>
    </Modal>
  );
}
