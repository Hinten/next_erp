'use client';

import { Table, Text } from '@mantine/core';
import { type ItemDoPedido, itemSubtotal } from '@delfrance/schemas';
import { format, money } from '@delfrance/core/money';

function brl(value: number): string {
  return format(money(Math.round(value * 100)));
}

export function ItensTable({ itens }: { itens: ItemDoPedido[] }) {
  if (itens.length === 0) {
    return <Text c="dimmed">Sem itens.</Text>;
  }
  const total = itens.reduce((n, i) => n + itemSubtotal(i), 0);
  return (
    <Table striped>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>#</Table.Th>
          <Table.Th>Produto</Table.Th>
          <Table.Th>SKU</Table.Th>
          <Table.Th align="right">Qtd</Table.Th>
          <Table.Th align="right">Preço</Table.Th>
          <Table.Th align="right">Desconto</Table.Th>
          <Table.Th align="right">Subtotal</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {itens.map((item, i) => (
          <Table.Tr key={`${item.produtoUid ?? 'NONE'}-${item.ordem}-${i}`}>
            <Table.Td>{item.ordem}</Table.Td>
            <Table.Td>{item.nomeDeVenda ?? item.produtoUid ?? '—'}</Table.Td>
            <Table.Td>{item.sku ?? '—'}</Table.Td>
            <Table.Td align="right">{item.quantidade}</Table.Td>
            <Table.Td align="right">{brl(item.precoDeVenda)}</Table.Td>
            <Table.Td align="right">
              {item.descontoUnitario ? brl(item.descontoUnitario) : '—'}
            </Table.Td>
            <Table.Td align="right">{brl(itemSubtotal(item))}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
      <Table.Tfoot>
        <Table.Tr>
          <Table.Td colSpan={6} align="right">
            <Text fw={600}>Total</Text>
          </Table.Td>
          <Table.Td align="right">
            <Text fw={600}>{brl(total)}</Text>
          </Table.Td>
        </Table.Tr>
      </Table.Tfoot>
    </Table>
  );
}
