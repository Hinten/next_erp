'use client';

import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowBackUp, IconTrash } from '@tabler/icons-react';
import { type UseFormReturn } from 'react-hook-form';
import { type Firestore, getDoc } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import {
  flattenItensDevolvidos,
  itemCusto,
  itemSubtotal,
  podeTrocar,
  type Pedido,
} from '@delfrance/schemas';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { CollectionSelect } from '@/components/collection-select/CollectionSelect';
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
}

export function DevolucaoTab({ form, db, disabled }: DevolucaoTabProps) {
  // Seed editable rows from the current form value. The tab remounts on every tab
  // switch (Tabs `keepMounted={false}`), so this re-reads prior edits each time.
  const [rows, setRows] = useState<DevolucaoEditRow[]>(() =>
    editRowsFromItensDevolvidos(form.getValues('itensDevolvidos')),
  );
  const [originModalOpen, setOriginModalOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  // `itensDevolvidos` (the form value) is the source of truth for save + totals;
  // every edit rebuilds it from the rows.
  function commit(next: DevolucaoEditRow[]) {
    setRows(next);
    form.setValue('itensDevolvidos', buildItensDevolvidos(next), { shouldDirty: true });
  }
  function updateRow(rowId: string, patch: Partial<DevolucaoEditRow>) {
    commit(rows.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)));
  }
  function toggleDelete(rowId: string) {
    commit(rows.map((r) => (r.rowId === rowId ? { ...r, _delete: !r._delete } : r)));
  }

  async function handlePickOrigin(emitted: unknown) {
    const id =
      typeof emitted === 'string'
        ? (emitted.split('/').filter(Boolean).pop() ?? null)
        : ((emitted as { id?: string } | null)?.id ?? null);
    if (!id) return;
    if (rows.some((r) => r.originId === id)) {
      notifications.show({ message: 'Esse pedido já foi adicionado.' });
      return;
    }
    setAdding(true);
    try {
      const snap = await getDoc(pedidoCollection.docRef(db, {}, id));
      const origin = snap.exists() ? (snap.data() as Pedido) : null;
      if (!origin) {
        notifications.show({ color: 'red', message: 'Pedido não encontrado.' });
        return;
      }
      if (!podeTrocar(origin.estado)) {
        notifications.show({
          color: 'red',
          message: `O pedido ${origin.numero ?? id} não pode ser devolvido pelo seu estado de pagamento.`,
        });
        return;
      }
      commit([...rows, ...clonePedidoItems(origin, id)]);
      setOriginModalOpen(false);
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({ color: 'red', message: err.message });
        return;
      }
      throw err;
    } finally {
      setAdding(false);
    }
  }

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
            onClick={() => commit([...rows, newAvulsoRow()])}
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

      <Modal
        opened={originModalOpen}
        onClose={() => setOriginModalOpen(false)}
        title="Adicionar pedido para devolução"
        centered
      >
        {/* Stop the inner picker's events from bubbling to the ancestor pedido
            <form> (React events cross the modal portal — see issue #231). */}
        {originModalOpen && (
          <div onSubmit={(e) => e.stopPropagation()}>
            <Stack>
              <Text size="sm" c="dimmed">
                Busque um pedido de saída pago pelo número. Seus itens entram como devolução.
              </Text>
              <CollectionSelect
                collection={pedidoCollection}
                labelField="numero"
                searchFields={['numero']}
                fieldName="devolucao-origin"
                value={null}
                onChange={handlePickOrigin}
                label="Pedido de origem"
                disabled={adding}
              />
            </Stack>
          </div>
        )}
      </Modal>
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
          onChange={(n) => onUpdate(row.rowId, { precoDeVenda: n ?? 0 })}
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
