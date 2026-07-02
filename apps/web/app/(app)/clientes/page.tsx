'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { deleteDoc, documentId, query, where } from 'firebase/firestore';
import {
  Alert,
  Badge,
  Button,
  CloseButton,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import {
  type Cliente,
  type TipoCliente,
  TIPO_CLIENTE_LABELS,
  clienteMeta,
  clienteSchema,
} from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { formatCpfCnpj, formatTelefone, obscure } from '@/lib/pedido-print/format';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { ENDERECO_SEARCH_LIMIT, searchClienteIdsByEndereco } from './_lib/buscaPorEndereco';

// Stable empty reference so the `queryOverride` memo doesn't churn while no
// search results exist.
const NO_IDS: string[] = [];

// Telefone is stored as digits-only E.164 (no '+'), so BR numbers carry a
// leading `55` country code. Strip it before formatting so `formatTelefone`
// (which masks 10/11-digit BR numbers) sees the local number; legacy raw
// 10/11-digit numbers and foreign numbers pass through untouched.
function renderTelefone(value: string): string {
  const digits = value.replace(/\D/g, '');
  const local = digits.length >= 12 && digits.startsWith('55') ? digits.slice(2) : digits;
  return formatTelefone(local);
}

export default function ClientesPage() {
  const db = getFirebaseFirestore();
  // `enderecoInput` is the live text field; `enderecoTerm` is the committed
  // term (set on submit) that actually drives the search query.
  const [enderecoInput, setEnderecoInput] = useState('');
  const [enderecoTerm, setEnderecoTerm] = useState('');

  const searching = enderecoTerm.trim().length > 0;

  const enderecoSearch = useQuery({
    queryKey: ['clientes', 'busca-endereco', enderecoTerm],
    queryFn: () => searchClienteIdsByEndereco(db, enderecoTerm),
    enabled: searching,
  });

  const matchedIds = enderecoSearch.data ?? NO_IDS;

  // When a search is active and matched clients, constrain the list to them.
  // `documentId() in [...]` is capped at 30 ids — the helper already trims.
  const queryOverride = useMemo(
    () =>
      searching && matchedIds.length > 0
        ? query(clienteCollection.ref(db, {}), where(documentId(), 'in', matchedIds))
        : undefined,
    [db, searching, matchedIds],
  );

  // Show the table for the normal list and for a search that matched. Hide
  // it while the search is loading, errored, or returned nothing.
  const showTable = !searching || (enderecoSearch.isSuccess && matchedIds.length > 0);

  function runSearch() {
    setEnderecoTerm(enderecoInput);
  }

  function clearSearch() {
    setEnderecoInput('');
    setEnderecoTerm('');
  }

  return (
    <Stack>
      <Group align="flex-end">
        <TextInput
          label="Buscar cliente por endereço"
          placeholder="Logradouro, bairro, cidade ou CEP"
          value={enderecoInput}
          onChange={(e) => setEnderecoInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch();
          }}
          rightSection={
            enderecoInput ? (
              <CloseButton aria-label="Limpar busca por endereço" onClick={clearSearch} />
            ) : undefined
          }
          style={{ flex: 1, maxWidth: 420 }}
        />
        <Button onClick={runSearch} disabled={!enderecoInput.trim()}>
          Buscar
        </Button>
        {searching && (
          <Button variant="default" onClick={clearSearch}>
            Limpar
          </Button>
        )}
      </Group>

      {searching && enderecoSearch.isLoading && (
        <Group gap="xs">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            Buscando clientes por endereço…
          </Text>
        </Group>
      )}

      {enderecoSearch.isError && (
        <Alert color="red" title="Erro na busca por endereço">
          {enderecoSearch.error instanceof Error
            ? enderecoSearch.error.message
            : 'Falha ao buscar por endereço.'}
        </Alert>
      )}

      {searching && enderecoSearch.isSuccess && matchedIds.length === 0 && (
        <Alert color="gray" title="Nenhum resultado">
          Nenhum cliente encontrado para este endereço.
        </Alert>
      )}

      {searching && matchedIds.length >= ENDERECO_SEARCH_LIMIT && (
        <Alert color="yellow">
          Muitos endereços correspondem — exibindo os primeiros {ENDERECO_SEARCH_LIMIT} clientes.
        </Alert>
      )}

      {showTable && (
        <TableView<typeof clienteSchema>
          title="Clientes"
          schema={clienteSchema}
          collection={clienteCollection}
          db={db}
          meta={clienteMeta}
          defaultColumns={['nome', 'tipo', 'cpf_cnpj', 'email', 'telefone', 'ultimaModificacao']}
          rowHref={(id) => `/clientes/${id}`}
          queryOverride={queryOverride}
          renderNewButton={() => (
            <Button component={Link} href="/clientes/novo">
              Novo cliente
            </Button>
          )}
          copyHref="/clientes/novo"
          fields={{
            tipo: {
              renderCell: (value) =>
                value ? (
                  <Badge variant="light">
                    {TIPO_CLIENTE_LABELS[value as TipoCliente] ?? String(value)}
                  </Badge>
                ) : (
                  '—'
                ),
            },
            // LGPD: mask the document, hiding all but the trailing digits.
            cpf_cnpj: {
              renderCell: (value) => (value ? obscure(formatCpfCnpj(String(value))) : '—'),
            },
            telefone: {
              renderCell: (value) => (value ? renderTelefone(String(value)) : '—'),
            },
          }}
          selectable
          actions={[
            {
              id: 'delete',
              label: 'Excluir',
              color: 'red',
              requiresSelection: true,
              refreshOnComplete: true,
              confirm: {
                title: 'Excluir clientes',
                message: 'Clientes excluídos não podem ser restaurados. Confirmar exclusão?',
              },
              run: async (rows) => {
                await Promise.all(
                  rows.map((r: { id: string; data: Cliente }) =>
                    deleteDoc(clienteCollection.docRef(db, {}, r.id)),
                  ),
                );
              },
            },
          ]}
        />
      )}
    </Stack>
  );
}
