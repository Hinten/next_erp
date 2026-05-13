'use client';

import { useState } from 'react';
import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  Stack,
  Table,
  TextInput,
} from '@mantine/core';
import { type ItemDoPedido, itemSubtotal } from '@delfrance/schemas';
import { format, money } from '@delfrance/core/money';

function brl(value: number): string {
  return format(money(Math.round(value * 100)));
}

/**
 * Inline editor for the flattened list of items in a pedido. The detail
 * page persists the resulting list back into the grouped-by-produtoUid
 * structure on save.
 */
export function ItensEditor({
  initial,
  onChange,
}: {
  initial: ItemDoPedido[];
  onChange: (next: ItemDoPedido[]) => void;
}) {
  const [items, setItems] = useState<ItemDoPedido[]>(initial);

  function update(index: number, patch: Partial<ItemDoPedido>) {
    const next = items.map((item, i) =>
      i === index ? ({ ...item, ...patch } as ItemDoPedido) : item,
    );
    setItems(next);
    onChange(next);
  }

  function add() {
    const ordem = items.length === 0 ? 1 : Math.max(...items.map((i) => i.ordem)) + 1;
    const next: ItemDoPedido[] = [
      ...items,
      {
        ordem,
        precoDeVenda: 0.01,
        descontoUnitario: 0,
        quantidade: 1,
      },
    ];
    setItems(next);
    onChange(next);
  }

  function remove(index: number) {
    const next = items.filter((_, i) => i !== index);
    setItems(next);
    onChange(next);
  }

  const total = items.reduce((n, i) => n + itemSubtotal(i), 0);

  return (
    <Stack>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>#</Table.Th>
            <Table.Th>Produto / nome</Table.Th>
            <Table.Th>SKU</Table.Th>
            <Table.Th>Qtd</Table.Th>
            <Table.Th>Preço</Table.Th>
            <Table.Th>Desconto</Table.Th>
            <Table.Th align="right">Subtotal</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((item, i) => (
            <Table.Tr key={`${i}-${item.ordem}`}>
              <Table.Td>
                <NumberInput
                  value={item.ordem}
                  onChange={(v) =>
                    update(i, { ordem: typeof v === 'number' ? v : 1 })
                  }
                  min={1}
                  step={1}
                  w={70}
                />
              </Table.Td>
              <Table.Td>
                <TextInput
                  value={item.nomeDeVenda ?? ''}
                  onChange={(e) =>
                    update(i, { nomeDeVenda: e.currentTarget.value || null })
                  }
                  placeholder="Nome no pedido"
                />
              </Table.Td>
              <Table.Td>
                <TextInput
                  value={item.sku ?? ''}
                  onChange={(e) =>
                    update(i, { sku: e.currentTarget.value || null })
                  }
                />
              </Table.Td>
              <Table.Td>
                <NumberInput
                  value={item.quantidade}
                  onChange={(v) =>
                    update(i, { quantidade: typeof v === 'number' ? v : 0 })
                  }
                  min={0}
                  decimalScale={3}
                  w={100}
                />
              </Table.Td>
              <Table.Td>
                <NumberInput
                  value={item.precoDeVenda}
                  onChange={(v) =>
                    update(i, {
                      precoDeVenda: typeof v === 'number' ? v : 0.01,
                    })
                  }
                  min={0.01}
                  decimalScale={2}
                  w={120}
                />
              </Table.Td>
              <Table.Td>
                <NumberInput
                  value={item.descontoUnitario ?? 0}
                  onChange={(v) =>
                    update(i, {
                      descontoUnitario: typeof v === 'number' ? v : 0,
                    })
                  }
                  min={0}
                  decimalScale={2}
                  w={120}
                />
              </Table.Td>
              <Table.Td align="right">{brl(itemSubtotal(item))}</Table.Td>
              <Table.Td>
                <ActionIcon
                  color="red"
                  variant="subtle"
                  onClick={() => remove(i)}
                  aria-label="Remover"
                >
                  ✕
                </ActionIcon>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
        <Table.Tfoot>
          <Table.Tr>
            <Table.Td colSpan={6} align="right">
              <strong>Total</strong>
            </Table.Td>
            <Table.Td align="right">
              <strong>{brl(total)}</strong>
            </Table.Td>
            <Table.Td />
          </Table.Tr>
        </Table.Tfoot>
      </Table>
      <Group>
        <Button variant="light" onClick={add}>
          + Adicionar item
        </Button>
      </Group>
    </Stack>
  );
}
