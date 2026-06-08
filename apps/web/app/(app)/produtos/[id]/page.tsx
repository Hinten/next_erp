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
} from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function ProdutoDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const docRef = useMemo(
    () => produtoCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);

  async function handleDelete() {
    if (!confirm('Excluir este produto?')) return;
    await deleteDoc(docRef);
    router.replace('/produtos');
  }

  if (loading) {
    return (
      <Stack>
        <Skeleton height={32} width={240} />
        <Skeleton height={160} />
      </Stack>
    );
  }

  if (error) {
    return <Alert color="red">{error.message}</Alert>;
  }

  if (!data) {
    return (
      <Stack>
        <Alert color="yellow">Produto não encontrado.</Alert>
        <Anchor component={Link} href="/produtos">
          Voltar
        </Anchor>
      </Stack>
    );
  }

  const p = data.data;
  const dimensions = [p.alturaCm, p.larguraCm, p.profundidadeCm].filter(
    (n) => typeof n === 'number',
  );

  return (
    <Stack>
      <PageHeader
        title={
          <Group align="center">
            <Text fw={700} size="xl">
              {p.nome}
            </Text>
            {p.paiId && <Badge variant="light">variação</Badge>}
            {p.ehKit && (
              <Badge color="grape" variant="light">
                kit
              </Badge>
            )}
            {p.publicado ? (
              <Badge color="green" variant="light">
                Publicado
              </Badge>
            ) : (
              <Badge color="gray" variant="light">
                Oculto
              </Badge>
            )}
          </Group>
        }
        actions={
          <>
            <Button component={Link} href={`/produtos/${data.id}/editar`}>
              Editar
            </Button>
            <Button color="red" variant="light" onClick={handleDelete}>
              Excluir
            </Button>
          </>
        }
      />

      <Card withBorder>
        <Stack gap="xs">
          <Field label="SKU" value={p.sku} />
          <Field label="GTIN / EAN" value={p.gtin} />
          <Field label="Código no fornecedor" value={p.codFornecedor} />
          <Field label="Código pai" value={p.codPai} />
          <Divider my="sm" />
          {typeof p.pesoLiquidoKg === 'number' && (
            <Field label="Peso líquido" value={`${p.pesoLiquidoKg.toFixed(3)} kg`} />
          )}
          {typeof p.pesoBrutoKg === 'number' && (
            <Field label="Peso bruto" value={`${p.pesoBrutoKg.toFixed(3)} kg`} />
          )}
          {dimensions.length > 0 && (
            <Field
              label="Dimensões (A × L × P)"
              value={[p.alturaCm, p.larguraCm, p.profundidadeCm]
                .map((v) => (typeof v === 'number' ? `${v} cm` : '—'))
                .join(' × ')}
            />
          )}
          <Divider my="sm" />
          <Field label="Frete grátis" value={p.ofereceFreteGratis ? 'Sim' : 'Não'} />
          <Field
            label="Permite venda sem estoque"
            value={p.permiteVendaSemEstoque ? 'Sim' : 'Não'}
          />
          {typeof p.crossdocking === 'number' && (
            <Field label="Crossdocking" value={`${p.crossdocking} dia(s)`} />
          )}
          {p.variacoesUid && p.variacoesUid.length > 0 && (
            <>
              <Divider my="sm" />
              <Field label="Variações" value={`${p.variacoesUid.length} ID(s)`} />
            </>
          )}
        </Stack>
      </Card>

      <Anchor component={Link} href="/produtos" size="sm">
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
