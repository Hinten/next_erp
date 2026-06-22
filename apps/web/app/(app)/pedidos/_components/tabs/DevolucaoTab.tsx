'use client';

import { Alert, Card, Group, NumberInput, Stack, Table, Text, Title } from '@mantine/core';
import { type UseFormReturn } from 'react-hook-form';
import {
  flattenItensDevolvidos,
  itemCusto,
  itemSubtotal,
  type ItemDoPedido,
  type Pedido,
} from '@delfrance/schemas';
import type { PedidoFormState } from '../types';
import { buildDevolucaoRows, buildItensDevolvidos } from './devolucaoForm';

const brl = (n: number): string =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export interface DevolucaoTabProps {
  form: UseFormReturn<PedidoFormState, unknown, Pedido>;
  disabled?: boolean;
  /** Origin key for the returns map; `'NONE'` on a not-yet-saved pedido. */
  pedidoId?: string;
}

export function DevolucaoTab({ form, disabled, pedidoId }: DevolucaoTabProps) {
  // Read the live sold items (`_itensFlat`, what the Principal tab edits) and the
  // current returns; both drive the per-produto rows. `itensDevolvidos` is the
  // single source of truth — editing a row rewrites it via setValue, so no local
  // state is needed.
  const flat = form.watch('_itensFlat');
  const itensDevolvidos = form.watch('itensDevolvidos');
  const error = form.formState.errors.itensDevolvidos?.message;

  const rows = buildDevolucaoRows(flat as ItemDoPedido[], itensDevolvidos);
  const originKey = pedidoId ?? 'NONE';

  const devolvidos = flattenItensDevolvidos(itensDevolvidos);
  const valorDevolucao = devolvidos.reduce((sum, it) => sum + itemSubtotal(it), 0);
  const valorCustoDevolvidos = devolvidos.reduce((sum, it) => sum + itemCusto(it), 0);

  function setReturned(produtoUid: string, qty: number) {
    const next = rows.map((r) => (r.produtoUid === produtoUid ? { ...r, returnedQty: qty } : r));
    form.setValue('itensDevolvidos', buildItensDevolvidos(next, originKey), {
      shouldDirty: true,
      shouldValidate: true,
    });
  }

  return (
    <Stack>
      <Title order={3}>Devolução</Title>
      <Text size="sm" c="dimmed">
        Informe quanto de cada item vendido foi devolvido. A quantidade devolvida não pode passar da
        vendida.
      </Text>

      {error && <Alert color="red">{error}</Alert>}

      {rows.length === 0 ? (
        <Text c="dimmed" size="sm">
          Adicione itens ao pedido para registrar devoluções.
        </Text>
      ) : (
        <Card withBorder p={0}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Produto</Table.Th>
                <Table.Th w={120} ta="right">
                  Vendida
                </Table.Th>
                <Table.Th w={160}>Devolvida</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.produtoUid}>
                  <Table.Td>{row.nome}</Table.Td>
                  <Table.Td ta="right">{row.soldQty}</Table.Td>
                  <Table.Td>
                    <NumberInput
                      aria-label={`Quantidade devolvida de ${row.nome}`}
                      value={row.returnedQty}
                      onChange={(v) => {
                        const n = typeof v === 'number' ? v : Number(v);
                        setReturned(row.produtoUid, Number.isFinite(n) ? n : 0);
                      }}
                      min={0}
                      max={row.soldQty}
                      clampBehavior="strict"
                      disabled={disabled}
                      w={140}
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      <Group justify="flex-end" gap="xl">
        <Text size="sm">
          Valor devolvido: <strong>{brl(valorDevolucao)}</strong>
        </Text>
        <Text size="sm" c="dimmed">
          Custo devolvido: {brl(valorCustoDevolvidos)}
        </Text>
      </Group>
    </Stack>
  );
}
