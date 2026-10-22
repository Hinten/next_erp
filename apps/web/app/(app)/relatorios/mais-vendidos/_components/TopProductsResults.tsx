'use client';

import Link from 'next/link';
import { Anchor, Group, Image, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { PieChart } from '@mantine/charts';
import type {
  HydratedTopProductsRow,
  HydratedTopProductsVariation,
} from '@/lib/reports/topProducts';

const COLORS = [
  'blue.6',
  'teal.6',
  'orange.6',
  'violet.6',
  'cyan.6',
  'grape.6',
  'pink.6',
  'lime.7',
];
const quantityFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 6 });
const percentFormat = new Intl.NumberFormat('pt-BR', {
  style: 'percent',
  maximumFractionDigits: 2,
});
export const formatQuantity = (value: number) => quantityFormat.format(value);
const percentage = (quantity: number, total: number) =>
  percentFormat.format(total > 0 ? quantity / total : 0);

function ProductCells({ row, total }: { row: HydratedTopProductsVariation; total: number }) {
  return (
    <>
      <Table.Td w={64}>
        {row.photoUrl ? (
          <Image src={row.photoUrl} alt={row.nome} w={48} h={48} fit="contain" loading="lazy" />
        ) : (
          <Text c="dimmed" size="xs" aria-label="Sem foto">
            —
          </Text>
        )}
      </Table.Td>
      <Table.Td>{row.sku ?? '—'}</Table.Td>
      <Table.Td>
        <Anchor
          component={Link}
          href={'/produtos/' + encodeURIComponent(row.produtoId) + '/editar'}
        >
          {row.nome}
        </Anchor>
      </Table.Td>
      <Table.Td ta="right">{formatQuantity(row.quantidade)}</Table.Td>
      <Table.Td ta="right">{percentage(row.quantidade, total)}</Table.Td>
    </>
  );
}

function Headers({ ranked = false }: { ranked?: boolean }) {
  return (
    <Table.Thead>
      <Table.Tr>
        {ranked && <Table.Th>#</Table.Th>}
        <Table.Th>Foto</Table.Th>
        <Table.Th>SKU</Table.Th>
        <Table.Th>Produto</Table.Th>
        <Table.Th ta="right">Quantidade</Table.Th>
        <Table.Th ta="right">Participação</Table.Th>
      </Table.Tr>
    </Table.Thead>
  );
}

export function TopProductsResults({
  rows,
  total,
}: {
  rows: HydratedTopProductsRow[];
  total: number;
}) {
  const shown = rows.reduce((sum, row) => sum + row.quantidade, 0);
  const other = Math.max(0, total - shown);
  const pie = rows.map((row, index) => ({
    name: String(index + 1) + '. ' + row.nome,
    value: row.quantidade,
    color: COLORS[index % COLORS.length]!,
  }));
  if (other > 0) pie.push({ name: 'Outros produtos', value: other, color: 'gray.5' });

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>Produtos mais vendidos</Title>
        <Text fw={600}>Total de unidades: {formatQuantity(total)}</Text>
      </Group>
      {rows.length === 0 ? (
        <Text c="dimmed">Nenhuma venda encontrada no período e filtros selecionados.</Text>
      ) : (
        <>
          <Group align="center" gap="xl" wrap="wrap">
            <PieChart data={pie} size={260} withTooltip aria-label="Participação por produto pai" />
            <Stack component="ul" gap={6} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {pie.map((slice) => (
                <Text component="li" key={slice.name} size="sm">
                  {slice.name}: {formatQuantity(slice.value)} ({percentage(slice.value, total)})
                </Text>
              ))}
            </Stack>
          </Group>
          <Table.ScrollContainer minWidth={650}>
            <Table aria-label="Produtos mais vendidos" striped highlightOnHover>
              <Headers ranked />
              <Table.Tbody>
                {rows.map((row, index) => (
                  <Table.Tr
                    key={row.produtoId}
                    data-testid={'top-product-' + row.produtoId}
                    data-quantity={row.quantidade}
                  >
                    <Table.Td>{index + 1}</Table.Td>
                    <ProductCells row={row} total={total} />
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          <Title order={2}>Variações por produto</Title>
          {rows.map((row) => (
            <Paper key={row.produtoId} withBorder p="md" radius="md">
              <Stack>
                <Title order={3}>{row.nome}</Title>
                <Text size="sm" c="dimmed">
                  {formatQuantity(row.quantidade)} unidade(s) no período
                </Text>
                <Group align="flex-start" gap="lg" wrap="wrap">
                  <PieChart
                    size={200}
                    data={row.variations.map((variation, index) => ({
                      name: (variation.sku || variation.nome) + ' (' + variation.produtoId + ')',
                      value: variation.quantidade,
                      color: COLORS[index % COLORS.length]!,
                    }))}
                    withTooltip
                    aria-label={'Variações de ' + row.nome}
                  />
                  <Table.ScrollContainer minWidth={520} style={{ flex: '1 1 520px', minWidth: 0 }}>
                    <Table aria-label={'Variações de ' + row.nome} striped>
                      <Headers />
                      <Table.Tbody>
                        {row.variations.map((variation) => (
                          <Table.Tr key={variation.produtoId}>
                            <ProductCells row={variation} total={row.quantidade} />
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                </Group>
              </Stack>
            </Paper>
          ))}
        </>
      )}
    </Stack>
  );
}
