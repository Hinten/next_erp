'use client';

import { BarChart } from '@mantine/charts';
import { Paper, Stack, Table, Text, Title } from '@mantine/core';
import type { CheckoutReport } from '@/lib/reports/aggregations';

export function CheckoutResults({ report }: { report: CheckoutReport }) {
  return (
    <Stack>
      <Paper withBorder p="md">
        <Text c="dimmed" size="sm">
          Total de checkouts
        </Text>
        <Text size="xl" fw={700}>
          {report.total.toLocaleString('pt-BR')}
        </Text>
      </Paper>
      {report.total === 0 ? (
        <Text c="dimmed">Nenhum checkout encontrado no período.</Text>
      ) : (
        <>
          <Title order={2} size="h3">
            Checkouts por Usuário
          </Title>
          <Text size="sm" c="dimmed">
            Até 20 colaboradores entre os usuários com mais checkouts. Os demais e os não
            identificados entram em Outros usuários.
          </Text>
          <BarChart
            h={Math.max(300, report.rows.length * 36)}
            data={report.rows.map((row) => ({ usuario: row.label, Checkouts: row.count }))}
            dataKey="usuario"
            orientation="vertical"
            yAxisProps={{ width: 180 }}
            xAxisProps={{ allowDecimals: false }}
            series={[{ name: 'Checkouts', color: 'blue.6' }]}
            withTooltip
          />
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Usuário</Table.Th>
                <Table.Th ta="right">Checkouts</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {report.rows.map((row) => (
                <Table.Tr key={row.userId === null ? 'other' : `user:${row.userId}`}>
                  <Table.Td>{row.label}</Table.Td>
                  <Table.Td ta="right">{row.count.toLocaleString('pt-BR')}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}
    </Stack>
  );
}
