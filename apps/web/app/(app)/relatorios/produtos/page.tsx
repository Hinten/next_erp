'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Alert, Anchor, NumberInput, Skeleton, Stack, Table, Text } from '@mantine/core';
import { BarChart } from '@mantine/charts';
import { PageHeader } from '@delfrance/ui';
import { format, money } from '@delfrance/core/money';
import { useRecentPedidos } from '../_components/useRecentPedidos';
import { topProdutos } from '@/lib/reports/aggregations';

function brl(value: number): string {
  return format(money(Math.round(value * 100)));
}

export default function ProdutosMaisVendidosPage() {
  const [topN, setTopN] = useState<number>(10);
  const { data, loading, error } = useRecentPedidos();

  const rows = useMemo(() => {
    if (!data) return [];
    return topProdutos(data, topN);
  }, [data, topN]);

  return (
    <Stack>
      <PageHeader
        title="Produtos mais vendidos"
        description="Top N por quantidade vendida — agregado em tempo real sobre os últimos 500 pedidos"
        actions={
          <NumberInput
            label="Top"
            value={topN}
            onChange={(v) => setTopN(typeof v === 'number' ? v : 10)}
            min={1}
            max={50}
            step={1}
            w={120}
          />
        }
      />

      {error && <Alert color="red">{error.message}</Alert>}

      {loading ? (
        <Skeleton height={320} />
      ) : rows.length === 0 ? (
        <Text c="dimmed">Nenhuma venda registrada na janela atual.</Text>
      ) : (
        <>
          <BarChart
            h={320}
            data={rows.map((r) => ({
              produto: r.label,
              Quantidade: r.quantidade,
            }))}
            dataKey="produto"
            series={[{ name: 'Quantidade', color: 'blue.6' }]}
            withTooltip
          />

          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>#</Table.Th>
                <Table.Th>Produto</Table.Th>
                <Table.Th align="right">Quantidade</Table.Th>
                <Table.Th align="right">Pedidos</Table.Th>
                <Table.Th align="right">Receita</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r, i) => (
                <Table.Tr key={r.produtoUid}>
                  <Table.Td>{i + 1}</Table.Td>
                  <Table.Td>
                    <Anchor component={Link} href={`/produtos/${r.produtoUid}/editar`}>
                      {r.label}
                    </Anchor>
                  </Table.Td>
                  <Table.Td align="right">{r.quantidade}</Table.Td>
                  <Table.Td align="right">{r.pedidos}</Table.Td>
                  <Table.Td align="right">{brl(r.receita)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}

      <Anchor component={Link} href="/relatorios" size="sm">
        ← Voltar a Relatórios
      </Anchor>
    </Stack>
  );
}
