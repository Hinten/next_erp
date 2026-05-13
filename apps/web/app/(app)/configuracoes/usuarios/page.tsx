'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Group,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import {
  buildQuery,
  limit,
  orderByField,
  whereEqual,
} from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { useTenant } from '@/lib/auth';
import { cargoCollection } from '@/lib/data/cargoCollection';
import { usuarioCollection } from '@/lib/data/usuarioCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

const PAGE_SIZE = 50;

export default function UsuariosPage() {
  const router = useRouter();
  const { claims, loading: tenantLoading } = useTenant();

  const usuariosQuery = useMemo(() => {
    if (!claims?.grupoEconomico) return null;
    const base = usuarioCollection.ref(getFirebaseFirestore(), {});
    return buildQuery(base, [
      whereEqual('grupoEconomico', claims.grupoEconomico),
      orderByField('nome'),
      limit(PAGE_SIZE),
    ]);
  }, [claims?.grupoEconomico]);

  const cargosQuery = useMemo(() => {
    if (!claims?.grupoEconomico) return null;
    const base = cargoCollection.ref(getFirebaseFirestore(), {});
    return buildQuery(base, [
      whereEqual('grupoEconomico', claims.grupoEconomico),
    ]);
  }, [claims?.grupoEconomico]);

  const { data: usuarios, loading, error } = useSnapshot(usuariosQuery);
  const { data: cargos } = useSnapshot(cargosQuery);

  const cargoNameById = useMemo(() => {
    const m = new Map<string, string>();
    cargos?.forEach(({ id, data: c }) => m.set(id, c.nome));
    return m;
  }, [cargos]);

  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        <Title order={2}>Usuários</Title>
        <Text size="sm" c="dimmed">
          Criação de usuários via endpoint administrativo.
        </Text>
      </Group>

      {error && (
        <Alert color="red" title="Erro ao carregar usuários">
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

      {!loading && !tenantLoading && usuarios && (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Nome</Table.Th>
              <Table.Th>E-mail</Table.Th>
              <Table.Th>Cargos</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {usuarios.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={5} align="center">
                  Nenhum usuário cadastrado.
                </Table.Td>
              </Table.Tr>
            )}
            {usuarios.map(({ id, data: u }) => (
              <Table.Tr
                key={id}
                style={{ cursor: 'pointer' }}
                onClick={() => router.push(`/configuracoes/usuarios/${id}`)}
              >
                <Table.Td>
                  <Anchor
                    component={Link}
                    href={`/configuracoes/usuarios/${id}`}
                  >
                    {u.nome}
                  </Anchor>
                </Table.Td>
                <Table.Td>{u.email}</Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {u.cargos.length === 0 && <Text c="dimmed">—</Text>}
                    {u.cargos.map((cid) => (
                      <Badge key={cid} variant="light">
                        {cargoNameById.get(cid) ?? cid.slice(0, 6)}
                      </Badge>
                    ))}
                    {u.isSuperUser && (
                      <Badge color="red" variant="filled">
                        SU
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  {u.ativo ? (
                    <Badge color="green" variant="light">
                      Ativo
                    </Badge>
                  ) : (
                    <Badge color="gray" variant="light">
                      Inativo
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  <ActionIcon
                    component={Link}
                    href={`/configuracoes/usuarios/${id}/editar`}
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
