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
  Divider,
  Group,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { TIPO_CLIENTE_LABELS } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { formatCNPJ, formatCPF } from '@delfrance/core/documents';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function ClienteDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const docRef = useMemo(
    () => clienteCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);

  async function handleDelete() {
    if (!confirm('Excluir este cliente?')) return;
    await deleteDoc(docRef);
    router.replace('/clientes');
  }

  if (loading) {
    return (
      <Stack>
        <Skeleton height={32} width={200} />
        <Skeleton height={120} />
      </Stack>
    );
  }

  if (error) {
    return <Alert color="red">{error.message}</Alert>;
  }

  if (!data) {
    return (
      <Stack>
        <Alert color="yellow">Cliente não encontrado.</Alert>
        <Anchor component={Link} href="/clientes">
          Voltar
        </Anchor>
      </Stack>
    );
  }

  const c = data.data;
  const formattedDoc =
    c.cpf_cnpj && c.cpf_cnpj.length === 11
      ? formatCPF(c.cpf_cnpj)
      : c.cpf_cnpj && c.cpf_cnpj.length === 14
        ? formatCNPJ(c.cpf_cnpj)
        : c.cpf_cnpj;

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Group align="center">
          <Title order={2}>{c.nome ?? '(sem nome)'}</Title>
          {c.tipo && <Badge variant="light">{TIPO_CLIENTE_LABELS[c.tipo]}</Badge>}
        </Group>
        <Group>
          <Button component={Link} href={`/clientes/${data.id}/editar`}>
            Editar
          </Button>
          <Button color="red" variant="light" onClick={handleDelete}>
            Excluir
          </Button>
        </Group>
      </Group>

      <Card withBorder>
        <Stack gap="xs">
          <Field label="CPF / CNPJ" value={formattedDoc} />
          <Field label="E-mail" value={c.email} />
          <Field label="Telefone" value={c.telefone} />
          <Divider my="sm" />
          <Field label="Inscrição Estadual" value={c.ie} />
          <Field label="Inscrição Municipal" value={c.imun} />
          <Field label="ID estrangeiro" value={c.idEstrangeiro} />
          {c.observacoesInternas && (
            <>
              <Divider my="sm" />
              <Text size="sm" c="dimmed">
                Observações internas
              </Text>
              <Text>{c.observacoesInternas}</Text>
            </>
          )}
        </Stack>
      </Card>

      <Anchor component={Link} href="/clientes" size="sm">
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
