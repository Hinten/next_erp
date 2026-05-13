'use client';

import { useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { aggregatePermissoes } from '@delfrance/schemas';
import { buildQuery } from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';
import { PermGate } from '../../_components/PermGate';
import { cargoCollection } from '@/lib/data/cargoCollection';
import { usuarioCollection } from '@/lib/data/usuarioCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import {
  PermissionEditor,
} from '../../_components/PermissionEditor';

export default function UsuarioDetailPage() {
  const params = useParams<{ id: string }>();

  const docRef = useMemo(
    () => usuarioCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );
  const { data, loading, error } = useDocSnapshot(docRef);

  const cargosQuery = useMemo(() => {
    const base = cargoCollection.ref(getFirebaseFirestore(), {});
    return buildQuery(base, []);
  }, []);
  const { data: cargos } = useSnapshot(cargosQuery);

  const cargoById = useMemo(() => {
    const m = new Map<string, { nome: string; permissoes: string }>();
    cargos?.forEach(({ id, data: c }) =>
      m.set(id, { nome: c.nome, permissoes: c.permissoes }),
    );
    return m;
  }, [cargos]);

  if (loading) {
    return (
      <Stack>
        <Skeleton height={32} width={200} />
        <Skeleton height={200} />
      </Stack>
    );
  }

  if (error) return <Alert color="red">{error.message}</Alert>;

  if (!data) {
    return (
      <Stack>
        <Alert color="yellow">Usuário não encontrado.</Alert>
        <Anchor component={Link} href="/configuracoes/usuarios">
          Voltar
        </Anchor>
      </Stack>
    );
  }

  const u = data.data;
  const effectiveBits = aggregatePermissoes(u, cargoById);

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Group align="center">
          <Title order={2}>{u.nome}</Title>
          {u.isSuperUser && (
            <Badge color="red" variant="filled">
              Superusuário
            </Badge>
          )}
          {!u.ativo && (
            <Badge color="gray" variant="light">
              Inativo
            </Badge>
          )}
        </Group>
        <PermGate
          bit={PERM.configuracoes.write}
          tooltipLabel="Sem permissão para editar (requer configurações.write)."
          fallback={<Button disabled>Editar</Button>}
        >
          <Button
            component={Link}
            href={`/configuracoes/usuarios/${data.id}/editar`}
          >
            Editar
          </Button>
        </PermGate>
      </Group>

      <Card withBorder>
        <Stack gap="xs">
          <Field label="E-mail" value={u.email} />
          <Field label="Colaborador interno" value={u.colaborador ? 'Sim' : 'Não'} />
          <Field
            label="Último acesso"
            value={u.ultimoAcesso ?? 'Nunca registrado'}
          />
          <Divider my="sm" />
          <Text fw={600}>Cargos</Text>
          {u.cargos.length === 0 ? (
            <Text c="dimmed">Nenhum cargo atribuído.</Text>
          ) : (
            <Group gap="xs">
              {u.cargos.map((cid) => {
                const c = cargoById.get(cid);
                return (
                  <Anchor
                    key={cid}
                    component={Link}
                    href={`/configuracoes/cargos/${cid}`}
                  >
                    <Badge variant="light">{c?.nome ?? cid.slice(0, 6)}</Badge>
                  </Anchor>
                );
              })}
            </Group>
          )}
        </Stack>
      </Card>

      <Card withBorder>
        <Stack gap="xs">
          <Title order={4}>Permissões efetivas</Title>
          <Text size="sm" c="dimmed">
            União das permissões dos cargos atribuídos.
          </Text>
          <PermissionEditor value={effectiveBits} readOnly />
        </Stack>
      </Card>

      <Anchor component={Link} href="/configuracoes/usuarios" size="sm">
        ← Voltar à lista
      </Anchor>
    </Stack>
  );
}

function Field({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <Group justify="space-between">
      <Text c="dimmed" size="sm">
        {label}
      </Text>
      <Text>{value}</Text>
    </Group>
  );
}
