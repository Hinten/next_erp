'use client';

import { useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  List,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { decodePermissoes } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { RequirePerm } from '@/lib/auth';
import { cargoCollection } from '@/lib/data/cargoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { permissionLabels } from '../../_components/PermissionEditor';

export default function CargoDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const docRef = useMemo(
    () => cargoCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);

  async function handleDelete() {
    if (!confirm('Excluir este cargo? Usuários atualmente atribuídos perderão essas permissões na próxima atualização de claim.')) {
      return;
    }
    await deleteDoc(docRef);
    router.replace('/configuracoes/cargos');
  }

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
        <Alert color="yellow">Cargo não encontrado.</Alert>
        <Anchor component={Link} href="/configuracoes/cargos">
          Voltar
        </Anchor>
      </Stack>
    );
  }

  const c = data.data;
  const labels = permissionLabels(decodePermissoes(c));

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>{c.nome}</Title>
        <RequirePerm bit={PERM.configuracoes.write} denied={null}>
          <Group>
            <Button
              component={Link}
              href={`/configuracoes/cargos/${data.id}/editar`}
            >
              Editar
            </Button>
            <Button color="red" variant="light" onClick={handleDelete}>
              Excluir
            </Button>
          </Group>
        </RequirePerm>
      </Group>

      {c.descricao && (
        <Card withBorder>
          <Text>{c.descricao}</Text>
        </Card>
      )}

      <Card withBorder>
        <Stack gap="xs">
          <Title order={4}>Permissões</Title>
          {labels.length === 0 ? (
            <Text c="dimmed">Nenhuma permissão atribuída.</Text>
          ) : (
            <Group gap="xs">
              {labels.map((label) => (
                <Badge key={label} variant="light">
                  {label}
                </Badge>
              ))}
            </Group>
          )}
          <List size="sm" c="dimmed" mt="md">
            <List.Item>Total: {labels.length} permissão(ões)</List.Item>
          </List>
        </Stack>
      </Card>

      <Anchor component={Link} href="/configuracoes/cargos" size="sm">
        ← Voltar à lista
      </Anchor>
    </Stack>
  );
}
