'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Anchor, Badge, Button, Group, Skeleton, Stack, Table, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { decodePermissoes } from '@delfrance/schemas';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { cargoCollection } from '@/lib/data/cargoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { PermGate } from '../_components/PermGate';

const PAGE_SIZE = 50;

function countBits(b: bigint): number {
  let n = 0;
  let v = b;
  while (v > 0n) {
    if (v & 1n) n++;
    v >>= 1n;
  }
  return n;
}

export default function CargosPage() {
  const router = useRouter();

  const q = useMemo(() => {
    const base = cargoCollection.ref(getFirebaseFirestore(), {});
    return buildQuery(base, [orderByField('nome'), limit(PAGE_SIZE)]);
  }, []);

  const { data, loading, error } = useSnapshot(q);

  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        <Title order={2}>Cargos</Title>
        <PermGate
          bit={PERM.configuracoes.write}
          tooltipLabel="Sem permissão para criar cargos (requer configurações.write)."
          fallback={<Button disabled>Novo cargo</Button>}
        >
          <Button component={Link} href="/configuracoes/cargos/novo">
            Novo cargo
          </Button>
        </PermGate>
      </Group>

      {error && (
        <Alert color="red" title="Erro ao carregar cargos">
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
              <Table.Th>Descrição</Table.Th>
              <Table.Th>Permissões</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={3} align="center">
                  Nenhum cargo cadastrado.
                </Table.Td>
              </Table.Tr>
            )}
            {data.map(({ id, data: c }) => (
              <Table.Tr
                key={id}
                style={{ cursor: 'pointer' }}
                onClick={() => router.push(`/configuracoes/cargos/${id}`)}
              >
                <Table.Td>
                  <Anchor component={Link} href={`/configuracoes/cargos/${id}`}>
                    {c.nome}
                  </Anchor>
                </Table.Td>
                <Table.Td>{c.descricao ?? '—'}</Table.Td>
                <Table.Td>
                  <Badge variant="light">{countBits(decodePermissoes(c))} permissões</Badge>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
