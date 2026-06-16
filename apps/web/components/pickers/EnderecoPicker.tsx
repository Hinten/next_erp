'use client';

import { useMemo, useState } from 'react';
import { Anchor, Select, Stack } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getDoc, getDocs, type Firestore } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { buildQuery, orderByField } from '@delfrance/data';
import { enderecoCollection } from '@/lib/data/enderecoCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { usePermission } from '@/lib/auth';
import { EnderecoFormModal } from './EnderecoFormModal';

/**
 * The subset of the endereco doc the picker reads. Docs come back from a
 * generic deref (`getDoc` on an arbitrary path), so every field is treated
 * as possibly missing.
 */
export interface EnderecoLike {
  cep?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  estado?: string | null;
  complemento?: string | null;
}

/**
 * Display label — mirror of the legacy `Endereco.toString`
 * (`.old/packages/clientes/lib/src/models.dart:776-778`):
 * `01310-100: Av Paulista, 1000, Bela Vista, São Paulo - SP`.
 */
export function enderecoLabel(e: EnderecoLike): string {
  const cep =
    e.cep && /^\d{8}$/.test(e.cep) ? `${e.cep.slice(0, 5)}-${e.cep.slice(5)}` : (e.cep ?? '');
  return `${cep}: ${e.logradouro ?? ''}, ${e.numero ?? ''}, ${e.bairro ?? ''}, ${e.cidade ?? ''} - ${e.estado ?? ''} ${e.complemento ?? ''}`.trim();
}

/**
 * Resolve an endereço outer ref (string `documents/...` path, opaque ref or
 * native DocumentReference) to its doc. Used by the picker for the current
 * selection and by the Frete tab for the destination CEP.
 */
export function useEnderecoFromRef(
  db: Firestore,
  outerRef: unknown,
): { endereco: EnderecoLike | null; path: string | null; loading: boolean } {
  const ref = useMemo(() => dereferenceOuterRef(db, outerRef), [db, outerRef]);
  const query = useQuery({
    queryKey: ['enderecoFromRef', ref?.path ?? null],
    enabled: ref != null,
    queryFn: async () => {
      const snap = await getDoc(ref!);
      return snap.exists() ? (snap.data() as EnderecoLike) : null;
    },
  });
  return {
    endereco: ref ? (query.data ?? null) : null,
    path: ref?.path ?? null,
    loading: ref != null && query.isLoading,
  };
}

export interface EnderecoPickerProps {
  db: Firestore;
  /** The cliente whose `enderecos` subcollection feeds the dropdown. */
  clienteOuterRef: unknown;
  /** Current outer ref (any legacy shape). */
  value: unknown;
  /** Emits the Flutter-ODM path string `documents/<path>` (or null). */
  onChange: (docPath: string | null) => void;
  label?: string;
  disabled?: boolean;
  error?: string;
}

/**
 * Endereço dropdown — port of the legacy `SeletorDeEnderecoWidget`
 * (`.old/lib/pedido/widgets.dart:549`): lists the selected cliente's
 * endereços ordered by logradouro and keeps an out-of-list current value
 * visible (e.g. an endereço belonging to another cliente). Creating /
 * editing endereços stays on the cliente screen.
 */
export function EnderecoPicker({
  db,
  clienteOuterRef,
  value,
  onChange,
  label = 'Endereço de entrega',
  disabled,
  error,
}: EnderecoPickerProps) {
  const clienteRef = useMemo(() => dereferenceOuterRef(db, clienteOuterRef), [db, clienteOuterRef]);
  const current = useEnderecoFromRef(db, value);
  const queryClient = useQueryClient();
  const { allowed: canWrite } = usePermission(PERM.endereco.write);
  const [modalOpen, setModalOpen] = useState(false);

  const list = useQuery({
    queryKey: ['enderecoPicker', clienteRef?.path ?? null],
    enabled: clienteRef != null,
    queryFn: async () => {
      const base = enderecoCollection.ref(db, { clienteId: clienteRef!.id });
      const snap = await getDocs(buildQuery(base, [orderByField('logradouro')]));
      return snap.docs.map((d) => ({ path: d.ref.path, data: d.data() as EnderecoLike }));
    },
  });

  const rows = useMemo(() => {
    const fromList = list.data ?? [];
    if (current.path && current.endereco && !fromList.some((r) => r.path === current.path)) {
      return [{ path: current.path, data: current.endereco }, ...fromList];
    }
    return fromList;
  }, [list.data, current.path, current.endereco]);

  return (
    <Stack gap={2}>
      <Select
        label={label}
        data={rows.map((r) => ({ value: r.path, label: enderecoLabel(r.data) }))}
        value={current.path}
        onChange={(path) => onChange(path ? `documents/${path}` : null)}
        placeholder={
          clienteRef ? 'Selecione um endereço…' : 'Selecione um cliente na aba Principal'
        }
        nothingFoundMessage="Nenhum endereço cadastrado para o cliente."
        clearable
        searchable
        disabled={disabled || (!clienteRef && !current.path)}
        error={error}
      />
      {!disabled && canWrite && clienteRef && (
        <Anchor component="button" type="button" size="xs" onClick={() => setModalOpen(true)}>
          + Novo endereço
        </Anchor>
      )}
      {clienteRef && (
        <EnderecoFormModal
          opened={modalOpen}
          onClose={() => setModalOpen(false)}
          clienteId={clienteRef.id}
          onSaved={(newId) => {
            setModalOpen(false);
            // Select the just-created endereço immediately. `useEnderecoFromRef`
            // resolves it as the out-of-list "current" value even before the
            // list query refetches; invalidating the list folds it in too.
            const newPath = enderecoCollection.docRef(db, { clienteId: clienteRef.id }, newId).path;
            void queryClient.invalidateQueries({ queryKey: ['enderecoPicker', clienteRef.path] });
            onChange(`documents/${newPath}`);
          }}
        />
      )}
    </Stack>
  );
}
