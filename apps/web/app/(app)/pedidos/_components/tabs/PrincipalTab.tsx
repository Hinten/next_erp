'use client';

import { useMemo } from 'react';
import {
  ActionIcon,
  Button,
  Card,
  Group,
  NumberInput,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { Controller, useFieldArray, type UseFormReturn } from 'react-hook-form';
import { type DocumentReference, type Firestore } from 'firebase/firestore';
import {
  type Pedido,
  type Produto,
  itemSubtotal,
} from '@delfrance/schemas';
import { format, money } from '@delfrance/core/money';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { ClientePicker } from '@/components/pickers/ClientePicker';
import { ProdutoPicker } from '@/components/pickers/ProdutoPicker';
import { OperacaoPicker } from '@/components/pickers/OperacaoPicker';
import { IntegracaoPicker } from '@/components/pickers/IntegracaoPicker';
import { ListaDePrecosPicker } from '@/components/pickers/ListaDePrecosPicker';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import type { PedidoFormState } from '../types';
import { makeRowId } from '../flattenItens';

function brl(value: number): string {
  return format(money(Math.round(value * 100)));
}

export interface PrincipalTabProps {
  form: UseFormReturn<PedidoFormState, unknown, Pedido>;
  db: Firestore;
  disabled?: boolean;
  /** The current user's uid; surfaced as the read-only "Vendedor" line. */
  vendedorLabel?: string;
}

export function PrincipalTab({
  form,
  db,
  disabled,
  vendedorLabel,
}: PrincipalTabProps) {
  const ehSaida = form.watch('ehSaida') ?? true;
  const listaDePrecosOuterRef = form.watch('listaDePrecosOuterRef');

  const fieldArray = useFieldArray({
    control: form.control,
    name: '_itensFlat',
    keyName: '__rhfKey',
  });

  const itensFlatRaw = form.watch('_itensFlat');
  const itensFlat = useMemo(() => itensFlatRaw ?? [], [itensFlatRaw]);
  const descontoTotal = form.watch('descontoTotal') ?? 0;

  const subtotal = useMemo(
    () => itensFlat.reduce((n, i) => n + itemSubtotal(i), 0),
    [itensFlat],
  );
  const total = subtotal - (descontoTotal ?? 0);

  const listaRef = useMemo(
    () => dereferenceOuterRef(db, listaDePrecosOuterRef),
    [db, listaDePrecosOuterRef],
  );
  const listaRefTyped = useMemo(
    () => (listaRef ? listaDePrecosCollection.docRef(db, {}, listaRef.id) : null),
    [db, listaRef],
  );
  const { data: listaDoc } = useDocSnapshot(listaRefTyped);

  function addItem(produto: Produto | null, produtoRef: DocumentReference<Produto> | null, produtoId: string | null) {
    const nextOrdem =
      itensFlat.length === 0
        ? 1
        : Math.max(...itensFlat.map((i) => i.ordem)) + 1;
    fieldArray.append({
      _rowId: makeRowId(),
      produtoUid: produtoId,
      ordem: nextOrdem,
      ensureUniqueId: null,
      mktplaceId: null,
      sku: produto?.sku ?? null,
      gtin: produto?.gtin ?? null,
      nomeDeVenda: produto?.nome ?? null,
      precoDeVenda: 0.01,
      descontoUnitario: 0,
      quantidade: 1,
      custo: null,
      timestamp: null,
      imposto: null,
    });
  }

  return (
    <Stack>
      <Card withBorder>
        <Stack>
          <Text size="sm" c="dimmed">
            Vendedor
          </Text>
          <Text>{vendedorLabel ?? '—'}</Text>
        </Stack>
      </Card>

      <Controller
        control={form.control}
        name="clientePedidoOuterRef"
        render={({ field, fieldState }) => (
          <ClientePicker
            db={db}
            value={field.value}
            onChange={(ref) => field.onChange(ref)}
            disabled={disabled}
            error={fieldState.error?.message}
          />
        )}
      />

      <Group grow>
        <Controller
          control={form.control}
          name="operacaoPedidoOuterRef"
          render={({ field, fieldState }) => (
            <OperacaoPicker
              db={db}
              ehSaida={!!ehSaida}
              value={field.value}
              onChange={(ref) => field.onChange(ref)}
              disabled={disabled}
              error={fieldState.error?.message}
            />
          )}
        />
        <Controller
          control={form.control}
          name="integracaoPedidoOuterRef"
          render={({ field, fieldState }) => (
            <IntegracaoPicker
              db={db}
              value={field.value}
              onChange={(ref) => field.onChange(ref)}
              required
              disabled={disabled}
              error={fieldState.error?.message}
            />
          )}
        />
      </Group>

      <Controller
        control={form.control}
        name="listaDePrecosOuterRef"
        render={({ field, fieldState }) => (
          <ListaDePrecosPicker
            db={db}
            value={field.value}
            onChange={(ref) => field.onChange(ref)}
            disabled={disabled}
            error={fieldState.error?.message}
          />
        )}
      />

      <Stack gap="xs">
        <Group justify="space-between" align="center">
          <Title order={4}>Itens</Title>
          <AddItemControl
            db={db}
            disabled={disabled}
            onPicked={(result) => {
              addItem(
                result?.data ?? null,
                result?.ref ?? null,
                result?.id ?? null,
              );
            }}
          />
        </Group>

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
            {fieldArray.fields.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={8} align="center">
                  <Text c="dimmed" size="sm">
                    Nenhum item. Use a busca acima para adicionar.
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {fieldArray.fields.map((field, index) => (
              <ItemRow
                key={field.__rhfKey}
                index={index}
                form={form}
                disabled={disabled}
                listaDePrecosId={listaDoc?.id ?? null}
                onRemove={() => fieldArray.remove(index)}
              />
            ))}
          </Table.Tbody>
          <Table.Tfoot>
            <Table.Tr>
              <Table.Td colSpan={6} align="right">
                <Text size="sm" c="dimmed">
                  Subtotal
                </Text>
              </Table.Td>
              <Table.Td align="right">{brl(subtotal)}</Table.Td>
              <Table.Td />
            </Table.Tr>
            <Table.Tr>
              <Table.Td colSpan={6} align="right">
                <Text size="sm" c="dimmed">
                  Desconto total
                </Text>
              </Table.Td>
              <Table.Td align="right">
                <Controller
                  control={form.control}
                  name="descontoTotal"
                  render={({ field }) => (
                    <NumberInput
                      value={field.value ?? 0}
                      onChange={(v) =>
                        field.onChange(typeof v === 'number' ? v : 0)
                      }
                      onBlur={field.onBlur}
                      min={0}
                      decimalScale={2}
                      w={120}
                      disabled={disabled}
                    />
                  )}
                />
              </Table.Td>
              <Table.Td />
            </Table.Tr>
            <Table.Tr>
              <Table.Td colSpan={6} align="right">
                <Text fw={700}>Total</Text>
              </Table.Td>
              <Table.Td align="right">
                <Text fw={700}>{brl(total)}</Text>
              </Table.Td>
              <Table.Td />
            </Table.Tr>
          </Table.Tfoot>
        </Table>
        <Text size="xs" c="dimmed">
          Frete e devoluções não inclusos nesta visualização.
        </Text>
      </Stack>

      <Controller
        control={form.control}
        name="observacoesInternas"
        render={({ field }) => (
          <Textarea
            label="Observações internas"
            value={field.value ?? ''}
            onChange={(e) => field.onChange(e.currentTarget.value || null)}
            onBlur={field.onBlur}
            rows={5}
            disabled={disabled}
          />
        )}
      />
    </Stack>
  );
}

function AddItemControl({
  db,
  disabled,
  onPicked,
}: {
  db: Firestore;
  disabled?: boolean;
  onPicked: (result: {
    ref: DocumentReference<Produto>;
    id: string;
    data: Produto;
  } | null) => void;
}) {
  // The picker is a one-shot selector here — clearing the value also
  // resets it, so each search adds a fresh row.
  return (
    <Group gap="xs" align="end" style={{ minWidth: 320 }}>
      <ProdutoPicker
        db={db}
        value={null}
        onChange={(r) => {
          if (r) {
            onPicked(r);
          }
        }}
        label=""
        placeholder="Adicionar item por busca…"
        disabled={disabled}
      />
    </Group>
  );
}

function ItemRow({
  index,
  form,
  disabled,
  listaDePrecosId,
  onRemove,
}: {
  index: number;
  form: UseFormReturn<PedidoFormState, unknown, Pedido>;
  disabled?: boolean;
  listaDePrecosId: string | null;
  onRemove: () => void;
}) {
  const item = form.watch(`_itensFlat.${index}`);

  return (
    <Table.Tr>
      <Table.Td>
        <Controller
          control={form.control}
          name={`_itensFlat.${index}.ordem` as const}
          render={({ field }) => (
            <NumberInput
              value={field.value ?? 1}
              onChange={(v) =>
                field.onChange(typeof v === 'number' ? v : 1)
              }
              onBlur={field.onBlur}
              min={1}
              step={1}
              w={70}
              disabled={disabled}
            />
          )}
        />
      </Table.Td>
      <Table.Td>
        <Controller
          control={form.control}
          name={`_itensFlat.${index}.nomeDeVenda` as const}
          render={({ field }) => (
            <TextInput
              value={field.value ?? ''}
              onChange={(e) =>
                field.onChange(e.currentTarget.value || null)
              }
              onBlur={field.onBlur}
              placeholder="Nome no pedido"
              disabled={disabled}
            />
          )}
        />
      </Table.Td>
      <Table.Td>
        <Controller
          control={form.control}
          name={`_itensFlat.${index}.sku` as const}
          render={({ field }) => (
            <TextInput
              value={field.value ?? ''}
              onChange={(e) =>
                field.onChange(e.currentTarget.value || null)
              }
              onBlur={field.onBlur}
              disabled={disabled}
            />
          )}
        />
      </Table.Td>
      <Table.Td>
        <Controller
          control={form.control}
          name={`_itensFlat.${index}.quantidade` as const}
          render={({ field }) => (
            <NumberInput
              value={field.value ?? 0}
              onChange={(v) =>
                field.onChange(typeof v === 'number' ? v : 0)
              }
              onBlur={field.onBlur}
              min={0}
              decimalScale={3}
              w={100}
              disabled={disabled}
              aria-label={`Quantidade item ${index + 1}`}
            />
          )}
        />
      </Table.Td>
      <Table.Td>
        <Controller
          control={form.control}
          name={`_itensFlat.${index}.precoDeVenda` as const}
          render={({ field }) => (
            <NumberInput
              value={field.value ?? 0.01}
              onChange={(v) =>
                field.onChange(typeof v === 'number' ? v : 0.01)
              }
              onBlur={field.onBlur}
              min={0.01}
              decimalScale={2}
              w={120}
              disabled={disabled}
              aria-label={`Preço item ${index + 1}`}
            />
          )}
        />
      </Table.Td>
      <Table.Td>
        <Controller
          control={form.control}
          name={`_itensFlat.${index}.descontoUnitario` as const}
          render={({ field }) => (
            <NumberInput
              value={field.value ?? 0}
              onChange={(v) =>
                field.onChange(typeof v === 'number' ? v : 0)
              }
              onBlur={field.onBlur}
              min={0}
              decimalScale={2}
              w={120}
              disabled={disabled}
              aria-label={`Desconto item ${index + 1}`}
            />
          )}
        />
      </Table.Td>
      <Table.Td align="right">{brl(itemSubtotal(item))}</Table.Td>
      <Table.Td>
        <ActionIcon
          color="red"
          variant="subtle"
          onClick={onRemove}
          aria-label="Remover"
          disabled={disabled}
        >
          ✕
        </ActionIcon>
      </Table.Td>
    </Table.Tr>
  );
}
