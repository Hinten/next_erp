'use client';

import { useMemo } from 'react';
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
  Title,
} from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { decodePermissoes } from '@delfrance/schemas';
import {
  buildQuery,
  limit,
  orderByField,
  whereEqual,
} from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { RequirePerm, useTenant } from '@/lib/auth';
import { cargoCollection } from '@/lib/data/cargoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

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
  const { claims, loading: tenantLoading } = useTenant();

  const q = useMemo(() => {
    if (!claims?.grupoEconomico) return null;
    const base = cargoCollection.ref(getFirebaseFirestore(), {});
    return buildQuery(base, [
      whereEqual('grupoEconomico', claims.grupoEconomico),
      orderByField('nome'),
      limit(PAGE_SIZE),
    ]);
  }, [claims?.grupoEconomico]);

  const { data, loading, error } = useSnapshot(q);

  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        <Title order={2}>Cargos</Title>
        <RequirePerm bit={PERM.configuracoes.write} denied={null}>
          <Button component={Link} href="/configuracoes/cargos/novo">
            Novo cargo
          </Button>
        </RequirePerm>
      </Group>

      {error && (
        <Alert color="red" title="Erro ao carregar cargos">
          {error.message}
        </Alert>
      )}

      {(loading || tenantLoading) && (
        <Stack>
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
        </Stack>
      )}

      {!loading && !tenantLoading && data && (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Nome</Table.Th>
              <Table.Th>Descrição</Table.Th>
              <Table.Th>Permissões</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={4} align="center">
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
                  <Badge variant="light">
                    {countBits(decodePermissoes(c))} permissões
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <ActionIcon
                    component={Link}
                    href={`/configuracoes/cargos/${id}/editar`}
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
