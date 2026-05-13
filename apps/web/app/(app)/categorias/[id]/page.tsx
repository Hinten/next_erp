'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { deleteDoc } from 'firebase/firestore';
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
import { useDocSnapshot } from '@delfrance/data/hooks';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function CategoriaDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const docRef = useMemo(
    () => categoriaCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);

  async function handleDelete() {
    if (!confirm('Excluir esta categoria?')) return;
    await deleteDoc(docRef);
    router.replace('/categorias');
  }

  if (loading) {
    return (
      <Stack>
        <Skeleton height={32} width={200} />
        <Skeleton height={120} />
      </Stack>
    );
  }

  if (error) return <Alert color="red">{error.message}</Alert>;

  if (!data) {
    return (
      <Stack>
        <Alert color="yellow">Categoria não encontrada.</Alert>
        <Anchor component={Link} href="/categorias">
          Voltar
        </Anchor>
      </Stack>
    );
  }

  const c = data.data;

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Group align="center">
          <Title order={2}>{c.nome}</Title>
          {c.permiteCadastro === false && (
            <Badge variant="light" color="gray">
              Cadastro bloqueado
            </Badge>
          )}
        </Group>
        <Group>
          <Button component={Link} href={`/categorias/${data.id}/editar`}>
            Editar
          </Button>
          <Button color="red" variant="light" onClick={handleDelete}>
            Excluir
          </Button>
        </Group>
      </Group>

      <Card withBorder>
        <Stack gap="xs">
          {c.nomeCompleto && (
            <Group justify="space-between">
              <Text c="dimmed" size="sm">
                Nome completo
              </Text>
              <Text>{c.nomeCompleto}</Text>
            </Group>
          )}
          {c.categoriaGoogleId && (
            <Group justify="space-between">
              <Text c="dimmed" size="sm">
                Google Product Category ID
              </Text>
              <Text>{c.categoriaGoogleId}</Text>
            </Group>
          )}
          <Divider my="sm" />
          <Group justify="space-between">
            <Text c="dimmed" size="sm">
              Permite cadastro
            </Text>
            <Text>{c.permiteCadastro ? 'Sim' : 'Não'}</Text>
          </Group>
        </Stack>
      </Card>

      <Anchor component={Link} href="/categorias" size="sm">
        ← Voltar à lista
      </Anchor>
    </Stack>
  );
}
