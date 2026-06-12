'use client';

import Link from 'next/link';
import { Anchor, Stack } from '@mantine/core';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { CollectionSelect } from '@/components/collection-select/CollectionSelect';

/**
 * Optimized cliente selector — the shared picker for every field that
 * references a cliente (pedido Principal, Frete "Quem recebe", …).
 *
 * - Initial load capped at **5** docs, ordered by recency
 *   (`ultimaModificacao desc, timestamp desc` — `clienteSchema` already
 *   carries the stamp; pipeline sorts treat a missing field as null, so
 *   legacy Flutter-written clientes sort last instead of being excluded).
 * - Typing triggers the pipeline **regex** search (case/accent-insensitive
 *   `regexContains`) across nome, CPF/CNPJ, e-mail and telefone — any
 *   cliente is reachable regardless of the 5-doc initial window.
 * - `emitDocPath` picks the emitted wire shape: `true` → Flutter-ODM
 *   doc-path string `documents/clientes/<id>` (e.g.
 *   `freteInicial.clienteRecebedorOuterReference`); `false` → native
 *   `DocumentReference` (e.g. `clientePedidoOuterRef`, unchanged wire).
 * - "+ Novo cliente" links to the full registration page until the
 *   quick-create modal with deduplication lands (see the tracking issue).
 */

const INITIAL_LIMIT = 5;
const RECENCY_ORDER: Array<{ field: string; direction: 'desc' }> = [
  { field: 'ultimaModificacao', direction: 'desc' },
  { field: 'timestamp', direction: 'desc' },
];
const SEARCH_FIELDS = ['nome', 'cpf_cnpj', 'email', 'telefone'];

export interface ClientePickerProps {
  /** RHF field path — keys the per-instance "Recentes" cache. */
  fieldName: string;
  value: unknown;
  /** Emits a DocumentReference (or doc-path string with `emitDocPath`), or null. */
  onChange: (next: unknown) => void;
  onBlur?: () => void;
  label?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  emitDocPath?: boolean;
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
  emitDocPath = false,
}: ClientePickerProps) {
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
        emitDocPath={emitDocPath}
      />
      {!disabled && (
        <Anchor component={Link} href="/clientes/novo" target="_blank" size="xs">
          + Novo cliente
        </Anchor>
      )}
    </Stack>
  );
}
