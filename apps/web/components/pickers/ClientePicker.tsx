'use client';

import { useState } from 'react';
import { Anchor, Stack } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { usePermission } from '@/lib/auth';
import { CollectionSelect } from '@/components/collection-select/CollectionSelect';
import { ClienteQuickCreateModal } from './ClienteQuickCreateModal';

/**
 * Optimized cliente selector — the shared picker for every field that
 * references a cliente (pedido Principal, Frete "Quem recebe", …).
 *
 * - Initial load capped at **5** docs, ordered by recency
 *   (`ultimaModificacao desc, timestamp desc` — `clienteSchema` already
 *   carries the stamp; pipeline sorts treat a missing field as null, so
 *   legacy Flutter-written clientes sort last instead of being excluded).
 * - Typing triggers the pipeline **regex** search (case/accent-insensitive
 *   `regexContains`) across nome, CPF/CNPJ, idEstrangeiro, e-mail and
 *   telefone — any cliente is reachable regardless of the 5-doc initial
 *   window.
 * - Emits the Flutter-ODM doc-path string `documents/clientes/<id>` for every
 *   cliente ref (`clientePedidoOuterRef`, `clienteRecebedorOuterReference`, …).
 * - "+ Novo cliente" opens the quick-create modal (issue #143): minimal
 *   fields, dedup by CPF/CNPJ/idEstrangeiro (blocking) and telefone/e-mail
 *   (warning); on create or on picking an existing candidate the cliente is
 *   emitted into the form. Gated on the cliente write permission.
 */

const INITIAL_LIMIT = 5;
const RECENCY_ORDER: Array<{ field: string; direction: 'desc' }> = [
  { field: 'ultimaModificacao', direction: 'desc' },
  { field: 'timestamp', direction: 'desc' },
];
const SEARCH_FIELDS = ['nome', 'cpf_cnpj', 'idEstrangeiro', 'email', 'telefone'];

export interface ClientePickerProps {
  /** RHF field path — keys the per-instance "Recentes" cache. */
  fieldName: string;
  value: unknown;
  /** Emits a `documents/clientes/<id>` doc-path string, or null. */
  onChange: (next: unknown) => void;
  onBlur?: () => void;
  label?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
}

export function ClientePicker({
  fieldName,
  value,
  onChange,
  onBlur,
  label = 'Cliente',
  hint,
  required,
  disabled,
  error,
}: ClientePickerProps) {
  const { allowed: canCreateCliente } = usePermission(PERM.cliente.write);
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <Stack gap={2}>
      <CollectionSelect
        collection={clienteCollection}
        labelField="nome"
        searchFields={SEARCH_FIELDS}
        optionHintField="cpf_cnpj"
        fieldName={fieldName}
        label={label}
        hint={hint}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        required={required}
        disabled={disabled}
        error={error}
        limit={INITIAL_LIMIT}
        orderBy={RECENCY_ORDER}
      />
      {!disabled && canCreateCliente && (
        <Anchor component="button" type="button" size="xs" onClick={() => setModalOpen(true)}>
          + Novo cliente
        </Anchor>
      )}
      <ClienteQuickCreateModal
        opened={modalOpen}
        onClose={() => setModalOpen(false)}
        onResolve={({ id }) => {
          setModalOpen(false);
          // Same emit shape as CollectionSelect.handleChange — the picker's
          // locked chip resolves the label by dereferencing the value.
          onChange(`documents/${clienteCollection.resolvePath({})}/${id}`);
        }}
      />
    </Stack>
  );
}
