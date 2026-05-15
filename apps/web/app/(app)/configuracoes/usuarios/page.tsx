'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { cargoCollection } from '@/lib/data/cargoCollection';
import { usuarioCollection } from '@/lib/data/usuarioCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { PermGate } from '../_components/PermGate';

const PAGE_SIZE = 50;

export default function UsuariosPage() {
  const router = useRouter();

  const usuariosQuery = useMemo(() => {
    const base = usuarioCollection.ref(getFirebaseFirestore(), {});
    return buildQuery(base, [orderByField('nome'), limit(PAGE_SIZE)]);
  }, []);

  const cargosQuery = useMemo(() => {
    const base = cargoCollection.ref(getFirebaseFirestore(), {});
    return buildQuery(base, []);
  }, []);

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
        <PermGate
          bit={PERM.configuracoes.write}
          tooltipLabel="Sem permissão para criar usuários (requer configurações.write)."
          fallback={<Button disabled>Novo usuário</Button>}
        >
          <Button component={Link} href="/configuracoes/usuarios/novo">
            Novo usuário
          </Button>
        </PermGate>
      </Group>

      {error && (
        <Alert color="red" title="Erro ao carregar usuários">
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

      {!loading && usuarios && (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Nome</Table.Th>
              <Table.Th>E-mail</Table.Th>
              <Table.Th>Cargos</Table.Th>
              <Table.Th>Status</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {usuarios.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={4} align="center">
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
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
