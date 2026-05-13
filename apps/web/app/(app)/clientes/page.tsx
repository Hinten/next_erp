'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Skeleton,
  Stack,
  Table,
  TextInput,
  Title,
} from '@mantine/core';
import { TIPO_CLIENTE_LABELS } from '@delfrance/schemas';
import { buildQuery, orderByField, limit, whereOp } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

const PAGE_SIZE = 50;

export default function ClientesPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const trimmed = search.trim();

  const q = useMemo(() => {
    const base = clienteCollection.ref(getFirebaseFirestore(), {});
    if (!trimmed) {
      return buildQuery(base, [orderByField('nome'), limit(PAGE_SIZE)]);
    }
    // Prefix-match on nome via the documented `>=` / `<=` trick. For richer
    // search the UI hits the `vector_search` Cloud Function (Phase 1.5+).
    return buildQuery(base, [
      orderByField('nome'),
      whereOp('nome', '>=', trimmed),
      whereOp('nome', '<=', `${trimmed}`),
      limit(PAGE_SIZE),
    ]);
  }, [trimmed]);

  const { data, loading, error } = useSnapshot(q);

  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        <Title order={2}>Clientes</Title>
        <Button component={Link} href="/clientes/novo">
          Novo cliente
        </Button>
      </Group>

      <TextInput
        placeholder="Buscar por nome…"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />

      {error && (
        <Alert color="red" title="Erro ao carregar clientes">
          {error.message}
        </Alert>
      )}

      {loading && (
        <Stack>
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
        </Stack>
      )}

      {!loading && data && (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Nome</Table.Th>
              <Table.Th>Tipo</Table.Th>
              <Table.Th>CPF/CNPJ</Table.Th>
              <Table.Th>E-mail</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={5} align="center">
                  Nenhum cliente encontrado.
                </Table.Td>
              </Table.Tr>
            )}
            {data.map(({ id, data: c }) => (
              <Table.Tr
                key={id}
                style={{ cursor: 'pointer' }}
                onClick={() => router.push(`/clientes/${id}`)}
              >
                <Table.Td>
                  <Anchor component={Link} href={`/clientes/${id}`}>
                    {c.nome ?? '(sem nome)'}
                  </Anchor>
                </Table.Td>
                <Table.Td>
                  {c.tipo ? (
                    <Badge variant="light">{TIPO_CLIENTE_LABELS[c.tipo]}</Badge>
                  ) : (
                    '—'
                  )}
                </Table.Td>
                <Table.Td>{c.cpf_cnpj ?? '—'}</Table.Td>
                <Table.Td>{c.email ?? '—'}</Table.Td>
                <Table.Td>
                  <ActionIcon
                    component={Link}
                    href={`/clientes/${id}/editar`}
                    variant="subtle"
                    aria-label="Editar"
                    onClick={(e) => e.stopPropagation()}
                  >
                    ✎
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
