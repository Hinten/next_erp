'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  NumberInput,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowBackUp, IconPlus, IconTrash, IconX } from '@tabler/icons-react';
import { Controller, useFieldArray, type UseFormReturn } from 'react-hook-form';
import { getDoc, type Firestore } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import { type Pedido, type Produto, itemSubtotal } from '@delfrance/schemas';
import { formatReais, roundReais } from '@delfrance/core/money';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { ClientePicker } from '@/components/pickers/ClientePicker';
import { ProdutoPicker } from '@/components/pickers/ProdutoPicker';
import { OperacaoPicker } from '@/components/pickers/OperacaoPicker';
import { IntegracaoPicker } from '@/components/pickers/IntegracaoPicker';
import { ListaDePrecosPicker } from '@/components/pickers/ListaDePrecosPicker';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import type { PedidoFormState } from '../types';
import { makeRowId } from '../flattenItens';
import { precoFromProduto } from '../precoLookup';
import { ProdutoThumbnail } from '../ProdutoThumbnail';
import { ProdutoVariacaoLabel } from '../ProdutoVariacaoLabel';
import { useEstoqueDisponivel } from '../useEstoqueDisponivel';

function brl(value: number): string {
  return formatReais(value);
}

export interface PrincipalTabProps {
  form: UseFormReturn<PedidoFormState, unknown, Pedido>;
  db: Firestore;
  disabled?: boolean;
  /** The current user's uid; surfaced as the read-only "Vendedor" line. */
  vendedorLabel?: string;
}

export function PrincipalTab({ form, db, disabled, vendedorLabel }: PrincipalTabProps) {
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
  const freteValor = form.watch('freteInicial')?.valorCobrado ?? 0;

  // Totals exclude staged-deleted rows (they are dropped on save).
  const subtotal = useMemo(
    () => itensFlat.reduce((n, i) => (i._delete ? n : n + itemSubtotal(i)), 0),
    [itensFlat],
  );
  // Mirror of the saved `valorCobrado` (legacy `Pedido.total` — see
  // `derivePedidoFreteTotals`): subtotal − desconto + frete, 2-decimal.
  const total = roundReais(roundReais(roundReais(subtotal) - descontoTotal) + freteValor);

  const listaRef = useMemo(
    () => dereferenceOuterRef(db, listaDePrecosOuterRef),
    [db, listaDePrecosOuterRef],
  );
  const listaRefTyped = useMemo(
    () => (listaRef ? listaDePrecosCollection.docRef(db, {}, listaRef.id) : null),
    [db, listaRef],
  );
  const { data: listaDoc } = useDocSnapshot(listaRefTyped);
  const listaId = listaDoc?.id ?? null;

  // Surfaced by PedidoForm's resolver when the pedido has no items — the items
  // table has no inline error slot of its own, so render it next to the title.
  const itensErrorMessage = form.formState.errors._itensFlat?.message;

  function addItem() {
    const nextOrdem = itensFlat.length === 0 ? 1 : Math.max(...itensFlat.map((i) => i.ordem)) + 1;
    fieldArray.append({
      _rowId: makeRowId(),
      _delete: false,
      produtoUid: null,
      ordem: nextOrdem,
      ensureUniqueId: null,
      mktplaceId: null,
      sku: null,
      gtin: null,
      nomeDeVenda: null,
      precoDeVenda: 0.01,
      descontoUnitario: 0,
      quantidade: 1,
      custo: null,
      timestamp: null,
      imposto: null,
    });
  }

  // Re-price every priced row when the lista de preços changes to a new
  // (non-null) value — fetch each distinct produto, look up its price for the
  // new lista, and overwrite `precoDeVenda` ONLY when a price is found. Skipped
  // on the initial mount and on a no-op change (tracked via `prevListaRef`), so
  // an unrelated render never clobbers manual edits.
  const prevListaRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevListaRef.current;
    prevListaRef.current = listaId;
    // First run (undefined) or no actual change → nothing to do.
    if (prev === undefined || prev === listaId || !listaId) return;
    const rows = form.getValues('_itensFlat') ?? [];
    const produtoIds = Array.from(
      new Set(rows.filter((r) => !!r.produtoUid && !r._delete).map((r) => r.produtoUid as string)),
    );
    if (produtoIds.length === 0) return;

    let cancelled = false;
    void (async () => {
      const priceById = new Map<string, number | null>();
      await Promise.all(
        produtoIds.map(async (id) => {
          // A per-produto Firestore failure must not reject the whole batch —
          // treat it as "no price found" so the row keeps its current price.
          try {
            const snap = await getDoc(produtoCollection.docRef(db, {}, id));
            const data = snap.data();
            priceById.set(id, data ? await precoFromProduto(db, data, listaId) : null);
          } catch (err) {
            if (!(err instanceof FirebaseError)) throw err;
            priceById.set(id, null);
          }
        }),
      );
      if (cancelled) return;
      const current = form.getValues('_itensFlat') ?? [];
      current.forEach((row, i) => {
        if (!row.produtoUid || row._delete) return;
        const preco = priceById.get(row.produtoUid);
        if (typeof preco === 'number') {
          form.setValue(`_itensFlat.${i}.precoDeVenda`, preco, {
            shouldDirty: true,
            shouldValidate: true,
          });
        }
      });
      notifications.show({ message: 'Preços atualizados pela nova tabela' });
    })();
    return () => {
      cancelled = true;
    };
  }, [listaId, db, form]);

  return (
    <Stack>
      <Controller
        control={form.control}
        name="clientePedidoOuterRef"
        render={({ field, fieldState }) => (
          <ClientePicker
            fieldName={field.name}
            value={field.value}
            onChange={field.onChange}
            onBlur={field.onBlur}
            disabled={disabled}
            error={fieldState.error?.message}
          />
        )}
      />

      <Group grow align="flex-start">
        <TextInput label="Vendedor" value={vendedorLabel ?? '—'} readOnly disabled />
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
      </Group>

      <Stack gap="xs">
        <Title order={4}>Itens</Title>

        {itensErrorMessage && (
          <Text c="red" size="sm">
            {itensErrorMessage}
          </Text>
        )}

        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>#</Table.Th>
              <Table.Th>Produto</Table.Th>
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
                <Table.Td colSpan={7} align="center">
                  <Text c="dimmed" size="sm">
                    Nenhum item. Clique em &quot;Adicionar produto&quot;.
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {fieldArray.fields.map((field, index) => (
              <ItemRow
                key={field.__rhfKey}
                index={index}
                form={form}
                db={db}
                disabled={disabled}
                listaId={listaId}
              />
            ))}
          </Table.Tbody>
          <Table.Tfoot>
            <Table.Tr>
              <Table.Td colSpan={5} align="right">
                <Text size="sm" c="dimmed">
                  Subtotal
                </Text>
              </Table.Td>
              <Table.Td align="right">{brl(subtotal)}</Table.Td>
              <Table.Td />
            </Table.Tr>
            <Table.Tr>
              <Table.Td colSpan={5} align="right">
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
                      onChange={(v) => field.onChange(typeof v === 'number' ? v : 0)}
                      onBlur={field.onBlur}
                      min={0}
                      decimalScale={2}
                      decimalSeparator=","
                      thousandSeparator="."
                      w={120}
                      disabled={disabled}
                    />
                  )}
                />
              </Table.Td>
              <Table.Td />
            </Table.Tr>
            <Table.Tr>
              <Table.Td colSpan={5} align="right">
                <Text size="sm" c="dimmed">
                  Frete
                </Text>
              </Table.Td>
              <Table.Td align="right">{brl(freteValor)}</Table.Td>
              <Table.Td />
            </Table.Tr>
            <Table.Tr>
              <Table.Td colSpan={5} align="right">
                <Text fw={700}>Total</Text>
              </Table.Td>
              <Table.Td align="right">
                <Text fw={700}>{brl(total)}</Text>
              </Table.Td>
              <Table.Td />
            </Table.Tr>
          </Table.Tfoot>
        </Table>
        <Group justify="center">
          <Button
            type="button"
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={addItem}
            disabled={disabled}
          >
            Adicionar produto
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          Frete definido na aba Frete; devoluções não inclusas nesta visualização.
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

function ItemRow({
  index,
  form,
  db,
  disabled,
  listaId,
}: {
  index: number;
  form: UseFormReturn<PedidoFormState, unknown, Pedido>;
  db: Firestore;
  disabled?: boolean;
  listaId: string | null;
}) {
  const item = form.watch(`_itensFlat.${index}`);
  // Watch produtoUid as its own primitive so the docRef memo dep is a string
  // RHF returns directly (not a field destructured off the watched row object,
  // which the React Compiler flags as possibly-mutated).
  const produtoUid = form.watch(`_itensFlat.${index}.produtoUid`) ?? null;
  const marked = item?._delete ?? false;
  const preco = item?.precoDeVenda ?? 0;
  const desconto = item?.descontoUnitario ?? 0;
  const descontoError = desconto > preco ? 'Desconto maior que o preço' : undefined;

  // Live produto doc (for the preview thumbnail / variation label / stock).
  const produtoRef = useMemo(
    () => (produtoUid ? produtoCollection.docRef(db, {}, produtoUid) : null),
    [db, produtoUid],
  );
  const { data: produtoDoc } = useDocSnapshot(produtoRef);
  const produto: Produto | null = produtoDoc?.data ?? null;

  const estoque = useEstoqueDisponivel(db, produtoUid);

  const qtyRef = useRef<HTMLInputElement>(null);

  async function handlePick(produtoPicked: Produto, produtoId: string) {
    if (!listaId) {
      notifications.show({
        color: 'red',
        message: 'Selecione uma tabela de preços para adicionar produtos',
      });
      return;
    }
    form.setValue(`_itensFlat.${index}.produtoUid`, produtoId, {
      shouldDirty: true,
      shouldValidate: true,
    });
    form.setValue(`_itensFlat.${index}.sku`, produtoPicked.sku ?? null, { shouldDirty: true });
    form.setValue(`_itensFlat.${index}.nomeDeVenda`, produtoPicked.nome ?? null, {
      shouldDirty: true,
      shouldValidate: true,
    });
    form.setValue(`_itensFlat.${index}.descontoUnitario`, 0, { shouldDirty: true });

    // The price lookup may read Firestore (variation parent) — a network/
    // permission failure must not become an unhandled rejection. Surface it and
    // leave the 0.01 placeholder for manual entry.
    let found: number | null = null;
    let lookupFailed = false;
    try {
      found = await precoFromProduto(db, produtoPicked, listaId);
    } catch (err) {
      if (!(err instanceof FirebaseError)) throw err;
      lookupFailed = true;
      notifications.show({
        color: 'red',
        message: `Falha ao buscar o preço de "${produtoPicked.nome}". Tente novamente.`,
      });
    }
    if (typeof found === 'number') {
      form.setValue(`_itensFlat.${index}.precoDeVenda`, found, {
        shouldDirty: true,
        shouldValidate: true,
      });
    } else if (!lookupFailed) {
      notifications.show({
        color: 'yellow',
        message: `Preço não encontrado para "${produtoPicked.nome}" na tabela selecionada`,
      });
    }
    requestAnimationFrame(() => qtyRef.current?.focus());
  }

  function toggleDelete() {
    form.setValue(`_itensFlat.${index}._delete`, !marked, { shouldDirty: true });
  }

  function clearProduto() {
    form.setValue(`_itensFlat.${index}.produtoUid`, null, {
      shouldDirty: true,
      shouldValidate: true,
    });
    form.setValue(`_itensFlat.${index}.sku`, null, { shouldDirty: true });
    form.setValue(`_itensFlat.${index}.nomeDeVenda`, null, { shouldDirty: true });
  }

  const rowStyle = marked ? { opacity: 0.5 } : undefined;

  return (
    <Table.Tr style={rowStyle}>
      <Table.Td>
        {/* `#` (ordem) is an internal tracking field — read-only. */}
        <Text size="sm" c="dimmed">
          {item?.ordem ?? index + 1}
        </Text>
      </Table.Td>
      <Table.Td>
        {produtoUid ? (
          // Selected: a compact produto display with a de-select button (the
          // search picker collapses away). Shows name + SKU + stock + variation.
          <Group gap="xs" wrap="nowrap" align="center">
            <ProdutoThumbnail db={db} produto={produto} />
            <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
              <Group gap={6} align="center">
                <Text size="sm" fw={500} td={marked ? 'line-through' : undefined} truncate>
                  {produto?.nome || item?.nomeDeVenda || produtoUid}
                </Text>
                {estoque !== null && (
                  <Badge size="xs" color={estoque > 0 ? 'green' : 'red'}>
                    {estoque} em estoque
                  </Badge>
                )}
                {marked && (
                  <Badge size="xs" color="gray" variant="light">
                    Será excluída
                  </Badge>
                )}
              </Group>
              <ProdutoVariacaoLabel db={db} produto={produto} />
              <Text size="xs" c="dimmed">
                {produto?.sku ? `SKU: ${produto.sku}` : 'Sem SKU'}
              </Text>
            </Stack>
            <Tooltip label="Trocar produto" withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={clearProduto}
                disabled={disabled || marked}
                aria-label="Remover produto"
              >
                <IconX size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        ) : (
          // Empty row: the search picker.
          <ProdutoPicker
            db={db}
            value={null}
            onChange={(r) => {
              if (r) void handlePick(r.data, r.id);
            }}
            label=""
            placeholder="Buscar produto…"
            disabled={disabled || marked}
          />
        )}
      </Table.Td>
      <Table.Td>
        <Controller
          control={form.control}
          name={`_itensFlat.${index}.quantidade` as const}
          render={({ field }) => (
            <NumberInput
              ref={qtyRef}
              value={field.value ?? 0}
              onChange={(v) => field.onChange(typeof v === 'number' ? v : 0)}
              onBlur={field.onBlur}
              min={0}
              decimalScale={3}
              decimalSeparator=","
              thousandSeparator="."
              w={100}
              disabled={disabled || marked}
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
              onChange={(v) => field.onChange(typeof v === 'number' ? v : 0.01)}
              onBlur={field.onBlur}
              min={0.01}
              decimalScale={2}
              decimalSeparator=","
              thousandSeparator="."
              w={120}
              disabled={disabled || marked}
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
              onChange={(v) => field.onChange(typeof v === 'number' ? v : 0)}
              onBlur={field.onBlur}
              min={0}
              decimalScale={2}
              decimalSeparator=","
              thousandSeparator="."
              w={120}
              disabled={disabled || marked}
              error={descontoError}
              aria-label={`Desconto item ${index + 1}`}
            />
          )}
        />
      </Table.Td>
      <Table.Td align="right">{brl(itemSubtotal(item))}</Table.Td>
      <Table.Td>
        <Tooltip label={marked ? 'Desfazer' : 'Remover'} withArrow>
          <ActionIcon
            color={marked ? 'gray' : 'red'}
            variant="subtle"
            onClick={toggleDelete}
            aria-label={marked ? 'Desfazer remoção' : 'Remover item'}
            disabled={disabled}
          >
            {marked ? <IconArrowBackUp size={16} /> : <IconTrash size={16} />}
          </ActionIcon>
        </Tooltip>
      </Table.Td>
    </Table.Tr>
  );
}
