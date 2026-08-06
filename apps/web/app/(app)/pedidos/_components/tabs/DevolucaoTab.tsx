'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconArrowBackUp, IconTrash } from '@tabler/icons-react';
import { type UseFormReturn } from 'react-hook-form';
import { type Firestore } from 'firebase/firestore';
import {
  flattenItensDevolvidos,
  itemCusto,
  itemSubtotal,
  valuesEqual,
  type Pedido,
} from '@delfrance/schemas';
import { ProdutoPicker } from '@/components/pickers/ProdutoPicker';
import { CurrencyInput } from '@/app/(app)/produtos/_components/CurrencyInput';
import type { PedidoFormState } from '../types';
import {
  NONE_KEY,
  buildItensDevolvidos,
  clonePedidoItems,
  editRowsFromItensDevolvidos,
  newAvulsoRow,
  type DevolucaoEditRow,
} from './devolucaoForm';
import { OrigemPedidoPicker, type PickedOrigem } from './OrigemPedidoPicker';

const brl = (n: number): string =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function rowSubtotal(row: DevolucaoEditRow): number {
  return (row.precoDeVenda - row.descontoUnitario) * row.quantidade;
}

/** Group rows by origin, preserving insertion order, with avulso (`'NONE'`) last. */
function groupByOrigin(
  rows: DevolucaoEditRow[],
): Array<{ originId: string; label: string; rows: DevolucaoEditRow[] }> {
  const order: string[] = [];
  const byOrigin = new Map<string, DevolucaoEditRow[]>();
  for (const row of rows) {
    if (!byOrigin.has(row.originId)) {
      byOrigin.set(row.originId, []);
      order.push(row.originId);
    }
    byOrigin.get(row.originId)!.push(row);
  }
  order.sort((a, b) => (a === NONE_KEY ? 1 : 0) - (b === NONE_KEY ? 1 : 0));
  return order.map((originId) => ({
    originId,
    label: byOrigin.get(originId)![0]!.originLabel,
    rows: byOrigin.get(originId)!,
  }));
}

export interface DevolucaoTabProps {
  form: UseFormReturn<PedidoFormState, unknown, Pedido>;
  db: Firestore;
  disabled?: boolean;
  /** Current pedido id — excluded from the origin picker (can't return itself). */
  pedidoId?: string;
}

export function DevolucaoTab({ form, db, disabled, pedidoId }: DevolucaoTabProps) {
  // Seed editable rows from the current form value. The tab remounts on every tab
  // switch (Tabs `keepMounted={false}`), so this re-reads prior edits each time.
  const [rows, setRows] = useState<DevolucaoEditRow[]>(() =>
    editRowsFromItensDevolvidos(form.getValues('itensDevolvidos')),
  );
  const [originModalOpen, setOriginModalOpen] = useState(false);

  // `itensDevolvidos` (the form value) is the source of truth for save + totals.
  // Sync it whenever the rows change. Comparing the rebuilt value (instead of a
  // first-run flag) keeps this idempotent under React StrictMode's double-invoke
  // — no spurious dirty when nothing actually changed; all row mutations use
  // functional `setRows` so rapid edits can't drop an update.
  useEffect(() => {
    const next = buildItensDevolvidos(rows);
    const current = (form.getValues('itensDevolvidos') as unknown) ?? null;
    if (!valuesEqual(next, current)) {
      form.setValue('itensDevolvidos', next, { shouldDirty: true, shouldValidate: true });
    }
  }, [rows, form]);

  function updateRow(rowId: string, patch: Partial<DevolucaoEditRow>) {
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)));
  }
  function toggleDelete(rowId: string) {
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, _delete: !r._delete } : r)));
  }

  // The picker enforces eligibility + exclusion; just clone the chosen order. It
  // stays open so several orders can be added in a row.
  function handlePickOrigin(picked: PickedOrigem) {
    setRows((prev) => [...prev, ...clonePedidoItems(picked.data, picked.id)]);
  }

  // Hide the current pedido (can't return itself) and origins already added.
  const excludeIds = useMemo(() => {
    const ids = new Set<string>(rows.map((r) => r.originId).filter((id) => id !== NONE_KEY));
    if (pedidoId) ids.add(pedidoId);
    return ids;
  }, [rows, pedidoId]);

  const groups = useMemo(() => groupByOrigin(rows), [rows]);

  const itensDevolvidos = form.watch('itensDevolvidos');
  const devolvidos = flattenItensDevolvidos(itensDevolvidos);
  const valorDevolucao = devolvidos.reduce((sum, it) => sum + itemSubtotal(it), 0);
  const valorCustoDevolvidos = devolvidos.reduce((sum, it) => sum + itemCusto(it), 0);

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={3}>Devolução</Title>
        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            onClick={() => setRows((prev) => [...prev, newAvulsoRow()])}
            disabled={disabled}
          >
            + Produto avulso
          </Button>
          <Button size="xs" onClick={() => setOriginModalOpen(true)} disabled={disabled}>
            + Adicionar pedido
          </Button>
        </Group>
      </Group>

      {groups.length === 0 ? (
        <Text c="dimmed" size="sm">
          Nenhuma devolução. Adicione um pedido de origem ou um produto avulso.
        </Text>
      ) : (
        groups.map((group) => (
          <Card key={group.originId} withBorder>
            <Stack gap="xs">
              <Group gap="xs">
                <Text fw={500}>{group.label}</Text>
                {group.originId === NONE_KEY && (
                  <Badge variant="light" color="gray">
                    Avulso
                  </Badge>
                )}
              </Group>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Produto</Table.Th>
                    <Table.Th w={110}>Qtd</Table.Th>
                    <Table.Th w={150}>Preço un.</Table.Th>
                    <Table.Th w={150}>Desconto un.</Table.Th>
                    <Table.Th w={120} ta="right">
                      Subtotal
                    </Table.Th>
                    <Table.Th w={48} />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {group.rows.map((row) => (
                    <DevolucaoRowEditor
                      key={row.rowId}
                      row={row}
                      db={db}
                      disabled={disabled}
                      onUpdate={updateRow}
                      onToggleDelete={toggleDelete}
                    />
                  ))}
                </Table.Tbody>
              </Table>
            </Stack>
          </Card>
        ))
      )}

      <Group justify="flex-end" gap="xl">
        <Text size="sm">
          Valor devolvido: <strong>{brl(valorDevolucao)}</strong>
        </Text>
        <Text size="sm" c="dimmed">
          Custo devolvido: {brl(valorCustoDevolvidos)}
        </Text>
      </Group>

      <OrigemPedidoPicker
        db={db}
        opened={originModalOpen}
        onClose={() => setOriginModalOpen(false)}
        excludeIds={excludeIds}
        onPick={handlePickOrigin}
      />
    </Stack>
  );
}

function DevolucaoRowEditor({
  row,
  db,
  disabled,
  onUpdate,
  onToggleDelete,
}: {
  row: DevolucaoEditRow;
  db: Firestore;
  disabled?: boolean;
  onUpdate: (rowId: string, patch: Partial<DevolucaoEditRow>) => void;
  onToggleDelete: (rowId: string) => void;
}) {
  const isAvulso = row.originId === NONE_KEY;
  const dimmed = row._delete ? { opacity: 0.45 } : undefined;
  return (
    <Table.Tr style={dimmed}>
      <Table.Td>
        {isAvulso && !row.produtoUid ? (
          <ProdutoPicker
            db={db}
            value={null}
            onChange={(r) => {
              if (r) {
                onUpdate(row.rowId, {
                  produtoUid: r.id,
                  nome: r.data?.nome ?? r.id,
                  sku: r.data?.sku ?? null,
                });
              }
            }}
            label=""
            placeholder="Buscar produto avulso…"
            disabled={disabled || row._delete}
          />
        ) : (
          <Text size="sm">{row.nome || row.produtoUid}</Text>
        )}
      </Table.Td>
      <Table.Td>
        <NumberInput
          aria-label={`Quantidade devolvida de ${row.nome || 'item'}`}
          value={row.quantidade}
          onChange={(v) => {
            const n = typeof v === 'number' ? v : Number(v);
            onUpdate(row.rowId, { quantidade: Number.isFinite(n) ? n : 0 });
          }}
          min={0}
          max={row.maxQty ?? undefined}
          decimalScale={3}
          clampBehavior="strict"
          disabled={disabled || row._delete}
          w={96}
        />
      </Table.Td>
      <Table.Td>
        <CurrencyInput
          ariaLabel={`Preço de ${row.nome || 'item'}`}
          value={row.precoDeVenda}
          // Clearing emits null; keep the form's data-entry floor of 0.01 (the
          // SCHEMA floor is 0, relaxed in #794 for zero-priced marketplace
          // lines) so a cleared row never reads as a giveaway.
          onChange={(n) => onUpdate(row.rowId, { precoDeVenda: n ?? 0.01 })}
          disabled={disabled || row._delete}
        />
      </Table.Td>
      <Table.Td>
        <CurrencyInput
          ariaLabel={`Desconto de ${row.nome || 'item'}`}
          value={row.descontoUnitario}
          onChange={(n) => onUpdate(row.rowId, { descontoUnitario: n ?? 0 })}
          disabled={disabled || row._delete}
        />
      </Table.Td>
      <Table.Td ta="right">{brl(rowSubtotal(row))}</Table.Td>
      <Table.Td>
        <Tooltip label={row._delete ? 'Desfazer' : 'Remover'} withArrow>
          <ActionIcon
            variant="subtle"
            color={row._delete ? 'gray' : 'red'}
            onClick={() => onToggleDelete(row.rowId)}
            disabled={disabled}
            aria-label={row._delete ? 'Desfazer remoção' : 'Remover item'}
          >
            {row._delete ? <IconArrowBackUp size={16} /> : <IconTrash size={16} />}
          </ActionIcon>
        </Tooltip>
      </Table.Td>
    </Table.Tr>
  );
}
