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
  Skeleton,
  Stack,
  Table,
  TextInput,
} from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import { buildQuery, defaultQueryConstraints, whereOp } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { produtoMeta } from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

// U+F8FF: a very high private-use code point. Appended to the search term it
// bounds a nome prefix range (nome >= term && nome <= term + sentinel).
const PREFIX_SENTINEL = '\uf8ff';

export default function ProdutosPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const trimmed = search.trim();

  const q = useMemo(() => {
    const base = produtoCollection.ref(getFirebaseFirestore(), {});
    // The catalog listing (parents only — #119) is declared once on
    // produtoMeta.defaultQuery (`paiId == null`, orderBy nome, limit 50), so
    // the query and its Firestore index stay in lockstep. When searching, add
    // the nome prefix range on top: nome >= term && nome <= term + sentinel.
    const extraConstraints = trimmed
      ? [whereOp('nome', '>=', trimmed), whereOp('nome', '<=', `${trimmed}${PREFIX_SENTINEL}`)]
      : [];
    return buildQuery(
      base,
      defaultQueryConstraints(produtoMeta.defaultQuery!, { extraConstraints }),
    );
  }, [trimmed]);

  const { data, loading, error } = useSnapshot(q);

  return (
    <Stack>
      <PageHeader
        title="Produtos"
        description="Catálogo, variações e marketplaces"
        actions={
          <Button component={Link} href="/produtos/novo">
            Novo produto
          </Button>
        }
      />

      <TextInput
        placeholder="Buscar por nome…"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />

      {error && (
        <Alert color="red" title="Erro ao carregar produtos">
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
              <Table.Th>SKU</Table.Th>
              <Table.Th>GTIN</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={5} align="center">
                  Nenhum produto encontrado.
                </Table.Td>
              </Table.Tr>
            )}
            {data.map(({ id, data: p }) => (
              <Table.Tr
                key={id}
                style={{ cursor: 'pointer' }}
                onClick={() => router.push(`/produtos/${id}/editar`)}
              >
                <Table.Td>
                  <Anchor component={Link} href={`/produtos/${id}/editar`}>
                    {p.nome}
                  </Anchor>
                  {p.paiId && (
                    <Badge ml="xs" size="xs" variant="light" color="gray">
                      variação
                    </Badge>
                  )}
                  {p.ehKit && (
                    <Badge ml="xs" size="xs" variant="light" color="grape">
                      kit
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>{p.sku ?? '—'}</Table.Td>
                <Table.Td>{p.gtin ?? '—'}</Table.Td>
                <Table.Td>
                  {p.publicado ? (
                    <Badge color="green" variant="light">
                      Publicado
                    </Badge>
                  ) : (
                    <Badge color="gray" variant="light">
                      Oculto
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  <ActionIcon
                    component={Link}
                    href={`/produtos/${id}/editar`}
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
