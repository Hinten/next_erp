'use client';

import Link from 'next/link';
import { Alert, Anchor, Group, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { BarChart, DonutChart } from '@mantine/charts';
import { formatReais } from '@delfrance/core/money';
import type { PrintOption, PrintSalesReport } from '@/lib/reports/printSales';

const WITH_PRINT = 'Com estampa selecionada';
const WITHOUT_PRINT = 'Sem estampa selecionada';
const PRINT_COLOR = 'teal.7';
const OTHER_COLOR = 'blue.6';
const quantity = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 6 });
const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 2 });

export function PrintSalesResults({
  report,
  prints,
}: {
  report: PrintSalesReport;
  prints: readonly PrintOption[];
}) {
  const names = new Map(prints.map((print) => [print.id, print.nome]));
  const groups = [
    { label: WITH_PRINT, color: PRINT_COLOR, ...report.comEstampa },
    { label: WITHOUT_PRINT, color: OTHER_COLOR, ...report.semEstampa },
  ].map((group) => {
    const receitaLiquida = group.receitaBruta - group.desconto;
    const lucro = receitaLiquida - group.custo;
    return {
      ...group,
      receitaLiquida,
      lucro,
      margem: receitaLiquida > 0 ? lucro / receitaLiquida : 0,
    };
  });
  const total = report.comEstampa.quantidade + report.semEstampa.quantidade;
  const comparison = [
    {
      label: 'Unidades vendidas',
      values: groups.map((group) => quantity.format(group.quantidade)),
    },
    {
      label: 'Participação no volume',
      values: groups.map((group) => percent.format(total > 0 ? group.quantidade / total : 0)),
    },
    { label: 'Receita bruta', values: groups.map((group) => formatReais(group.receitaBruta)) },
    { label: 'Descontos', values: groups.map((group) => formatReais(group.desconto)) },
    { label: 'Receita líquida', values: groups.map((group) => formatReais(group.receitaLiquida)) },
    { label: 'Custo', values: groups.map((group) => formatReais(group.custo)) },
    { label: 'Lucro', values: groups.map((group) => formatReais(group.lucro)) },
    { label: 'Margem', values: groups.map((group) => percent.format(group.margem)) },
  ];
  const financialMetrics = [
    { label: 'Receita bruta', key: 'receitaBruta' },
    { label: 'Receita líquida', key: 'receitaLiquida' },
    { label: 'Custo', key: 'custo' },
    { label: 'Lucro', key: 'lucro' },
  ] as const;
  const financialData = financialMetrics.map(({ label, key }) => ({
    metric: label,
    ...Object.fromEntries(groups.map((group) => [group.label, group[key]])),
  }));

  return (
    <Stack gap="lg">
      {(report.semClassificacao > 0 || report.invalidLines > 0) && (
        <Alert color="yellow" title="Dados incompletos">
          {report.semClassificacao > 0 && (
            <Text size="sm">
              Unidades fora do comparativo por falta de dados do catálogo{' '}
              <strong>{quantity.format(report.semClassificacao)}</strong>
            </Text>
          )}
          {report.invalidLines > 0 && (
            <Text size="sm">
              Itens do pedido desconsiderados por dados inválidos{' '}
              <strong>{quantity.format(report.invalidLines)}</strong>
            </Text>
          )}
        </Alert>
      )}
      {total === 0 ? (
        <Text c="dimmed" role="status">
          Nenhuma venda classificável no período e nos estados selecionados.
        </Text>
      ) : (
        <>
          <Title order={2}>Comparativo de vendas</Title>
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
            <Stack gap="sm">
              <Title order={3} size="h5">
                Participação no volume
              </Title>
              <Group align="center">
                <DonutChart
                  data={groups
                    .filter((group) => group.quantidade > 0)
                    .map((group) => ({
                      name: group.label,
                      value: group.quantidade,
                      color: group.color,
                    }))}
                  size={170}
                  thickness={26}
                  chartLabel={quantity.format(total)}
                  withLabelsLine={false}
                  aria-label="Participação no volume"
                />
                <Stack gap="xs">
                  {groups.map((group) => (
                    <Text key={group.label} size="sm">
                      {group.label} <strong>{percent.format(group.quantidade / total)}</strong>
                    </Text>
                  ))}
                </Stack>
              </Group>
            </Stack>
            <Stack gap="sm" miw={0}>
              <Title order={3} size="h5">
                Comparativo financeiro
              </Title>
              <BarChart
                data={financialData}
                dataKey="metric"
                h={220}
                series={groups.map((group) => ({ name: group.label, color: group.color }))}
                valueFormatter={(value) => formatReais(value)}
                withYAxis={false}
                aria-label="Comparativo financeiro"
              />
            </Stack>
          </SimpleGrid>
          <Table.ScrollContainer minWidth={470}>
            <Table aria-label="Comparativo de vendas" striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Métrica</Table.Th>
                  {groups.map((group) => (
                    <Table.Th key={group.label} ta="right">
                      {group.label}
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {comparison.map((row) => (
                  <Table.Tr key={row.label}>
                    <Table.Th scope="row">{row.label}</Table.Th>
                    {row.values.map((value, index) => (
                      <Table.Td key={groups[index]!.label} ta="right">
                        {value}
                      </Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          <Stack gap="xs">
            <Title order={2}>Produtos vendidos com estampa</Title>
            <Text size="sm" c="dimmed">
              O relatório usa a composição atual dos kits no catálogo.
            </Text>
          </Stack>
          {report.rows.length === 0 ? (
            <Text c="dimmed" role="status">
              Nenhum produto vendido com as estampas selecionadas.
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={650}>
              <Table aria-label="Produtos vendidos com estampa" striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Produto</Table.Th>
                    <Table.Th>SKU</Table.Th>
                    <Table.Th>Estampas selecionadas</Table.Th>
                    <Table.Th ta="right">Unidades</Table.Th>
                    <Table.Th ta="right">Receita líquida</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {report.rows.map((row) => (
                    <Table.Tr key={row.id}>
                      <Table.Td>
                        <Anchor
                          component={Link}
                          href={'/produtos/' + encodeURIComponent(row.id) + '/editar'}
                        >
                          {row.nome}
                        </Anchor>
                      </Table.Td>
                      <Table.Td>{row.sku ?? '—'}</Table.Td>
                      <Table.Td>
                        {row.printIds.map((id) => names.get(id) ?? id).join(', ')}
                      </Table.Td>
                      <Table.Td ta="right">{quantity.format(row.quantidade)}</Table.Td>
                      <Table.Td ta="right">{formatReais(row.receitaLiquida)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </>
      )}
    </Stack>
  );
}
