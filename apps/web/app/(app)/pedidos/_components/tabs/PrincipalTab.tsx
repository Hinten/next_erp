'use client';

import { useMemo, useRef } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Group,
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
import {
  type Pedido,
  type Produto,
  estoqueDisponivel,
  itemSubtotal,
  makeEstoqueUid,
  unidadeVendavel,
} from '@delfrance/schemas';
import { formatReais } from '@delfrance/core/money';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { estoqueProdutoCollection } from '@/lib/data/estoqueProdutoCollection';
import { ClientePicker } from '@/components/pickers/ClientePicker';
import { ProdutoPicker } from '@/components/pickers/ProdutoPicker';
import { OperacaoPicker } from '@/components/pickers/OperacaoPicker';
import { IntegracaoPicker } from '@/components/pickers/IntegracaoPicker';
import { ListaDePrecosPicker } from '@/components/pickers/ListaDePrecosPicker';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import type { PedidoFormState } from '../types';
import { makeRowId } from '../flattenItens';
import { precoFromProduto } from '../precoLookup';
import { ProdutoThumbnail } from '@/components/ProdutoThumbnail';
import { ProdutoVariacaoLabel } from '../ProdutoVariacaoLabel';
import { useEstoqueDisponivel } from '../useEstoqueDisponivel';
import { DecimalInput } from '@delfrance/ui';

function brl(value: number): string {
  return formatReais(value);
}

export interface PrincipalTabProps {
  form: UseFormReturn<PedidoFormState, unknown, Pedido>;
  db: Firestore;
  disabled?: boolean;
  /**
   * Lock for "Observações internas" only. Unlike every other Principal field the
   * internal notes stay editable even when the pedido is estado-locked (legacy
   * `pedidoCadastro.dart:532` leaves it uncommented as read-only), so it gets the
   * bare write-permission gate instead of `disabled`.
   */
  observacoesDisabled?: boolean;
  /** The current user's uid; surfaced as the read-only "Vendedor" line. */
  vendedorLabel?: string;
}

export function PrincipalTab({
  form,
  db,
  disabled,
  observacoesDisabled,
  vendedorLabel,
}: PrincipalTabProps) {
  const ehSaida = form.watch('ehSaida') ?? true;
  const listaDePrecosOuterRef = form.watch('listaDePrecosOuterRef');
  const integracaoOuterRef = form.watch('integracaoPedidoOuterRef');

  // The pedido's fulfillment depósito, resolved ONCE (integração →
  // `depositoOuterRef`) and shared by every item's stock badge (#427). Null
  // until an integração with a depósito is picked — the badge then falls back
  // to the all-depósito own sum. Same deref chain as the pedido-print assembler.
  const integracaoRef = useMemo(
    () => dereferenceOuterRef(db, integracaoOuterRef),
    [db, integracaoOuterRef],
  );
  const integracaoRefTyped = useMemo(
    () => (integracaoRef ? integracaoCollection.docRef(db, {}, integracaoRef.id) : null),
    [db, integracaoRef],
  );
  const { data: integracaoDoc } = useDocSnapshot(integracaoRefTyped);
  const depositoId = useMemo(
    () => dereferenceOuterRef(db, integracaoDoc?.data.depositoOuterRef)?.id ?? null,
    [db, integracaoDoc],
  );

  const fieldArray = useFieldArray({
    control: form.control,
    name: '_itensFlat',
    keyName: '__rhfKey',
  });

  const itensFlatRaw = form.watch('_itensFlat');
  const itensFlat = useMemo(() => itensFlatRaw ?? [], [itensFlatRaw]);
  // The pedido totals (subtotal/desconto/frete/total) now live in the sticky
  // PedidoFooter so they stay visible across tabs; this tab only shows the
  // per-row Subtotal column.

  const listaRef = useMemo(
    () => dereferenceOuterRef(db, listaDePrecosOuterRef),
    [db, listaDePrecosOuterRef],
  );
  const listaRefTyped = useMemo(
    () => (listaRef ? listaDePrecosCollection.docRef(db, {}, listaRef.id) : null),
    [db, listaRef],
  );
  // WHICH lista: the form field, resolved synchronously by
  // `dereferenceOuterRef` — correct on the very first render.
  const listaIdSelecionada = listaRef?.id ?? null;
  // Whether that lista still EXISTS: only the snapshot can answer that, and it
  // lands a beat later. ⚠️ `useDocSnapshot` reports the two states separately —
  // `undefined` is "still loading", `null` is "the doc is not there"
  // (packages/data/src/hooks/useSnapshot.ts) — so test for `null` explicitly.
  // `listaDoc?.id ?? null` collapsed them, which made `handlePick` answer
  // "Selecione uma tabela de preços" during the load window for a lista that
  // exists perfectly well.
  const { data: listaDoc } = useDocSnapshot(listaRefTyped);
  const listaId = listaDoc === null ? null : listaIdSelecionada;

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

  // Re-price every priced row when the OPERATOR picks a different lista de
  // preços — fetch each distinct produto, look up its price for the new lista,
  // and overwrite `precoDeVenda` ONLY when a price is found.
  //
  // ⚠️ Driven by the picker's `onChange`, which is the one unambiguous "the
  // operator chose a different tabela" signal on this screen: the picker never
  // auto-selects, and nothing else in the app writes `listaDePrecosOuterRef`.
  // This used to be a `useEffect` watching the lista id, and an effect cannot
  // tell the operator's pick from the value merely ARRIVING. Three different
  // arrivals looked identical to it, and each one rewrote historical prices and
  // left the form dirty:
  //   - the lista snapshot resolving on mount, so simply OPENING a saved pedido
  //     re-priced it (the reported bug — worst on a pago pedido, whose prices
  //     are history and whose fields are locked);
  //   - a remount, since PedidoForm's Tabs use `keepMounted={false}`;
  //   - `useServerTruthSeed`'s `form.reset` correcting a stale cache-painted
  //     copy to server truth (PedidoForm.tsx), where another operator's lista
  //     change arrives as a plain value transition.
  // None of those is the operator. Do not move this back into an effect.
  const repriceToken = useRef(0);

  async function reprecificarPelaLista(outerRef: string | null) {
    // A locked pedido's prices are history. The picker itself is already
    // `disabled`, so this is defence in depth for any programmatic caller.
    if (disabled) return;
    const novaListaId = dereferenceOuterRef(db, outerRef)?.id ?? null;
    if (!novaListaId) return;
    const rows = form.getValues('_itensFlat') ?? [];
    const produtoIds = Array.from(
      new Set(rows.filter((r) => !!r.produtoUid && !r._delete).map((r) => r.produtoUid as string)),
    );
    if (produtoIds.length === 0) return;

    // Two picks in quick succession: only the LAST may write. Without this the
    // first lookup can land second and restore the prices it read.
    const token = ++repriceToken.current;
    const priceById = new Map<string, number | null>();
    await Promise.all(
      produtoIds.map(async (id) => {
        // A per-produto Firestore failure must not reject the whole batch —
        // treat it as "no price found" so the row keeps its current price.
        try {
          const snap = await getDoc(produtoCollection.docRef(db, {}, id));
          const data = snap.data();
          priceById.set(id, data ? await precoFromProduto(db, data, novaListaId) : null);
        } catch (err) {
          if (!(err instanceof FirebaseError)) throw err;
          priceById.set(id, null);
        }
      }),
    );
    if (token !== repriceToken.current) return;
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
  }

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
              onChange={(ref) => {
                field.onChange(ref);
                void reprecificarPelaLista(ref);
              }}
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
                depositoId={depositoId}
              />
            ))}
          </Table.Tbody>
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
          Subtotal, desconto, frete e total do pedido ficam no rodapé fixo abaixo.
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
            disabled={observacoesDisabled}
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
  depositoId,
}: {
  index: number;
  form: UseFormReturn<PedidoFormState, unknown, Pedido>;
  db: Firestore;
  disabled?: boolean;
  listaId: string | null;
  /** Pedido's integração depósito (kit-aware badge); null → all-depósito sum. */
  depositoId: string | null;
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

  // `id: produtoUid` immediately (own-badge starts before the doc lands); kit
  // fields fill in from the produto doc, so kits become kit-aware a beat later.
  const produtoParaEstoque = useMemo(
    () =>
      produtoUid
        ? {
            id: produtoUid,
            ehKit: produto?.ehKit ?? false,
            componentesKit: produto?.componentesKit ?? null,
            // From the doc this component already subscribes to — no extra read.
            paiId: produto?.paiId ?? null,
            filhoUnicoId: produto?.filhoUnicoId ?? null,
          }
        : null,
    [produtoUid, produto?.ehKit, produto?.componentesKit, produto?.paiId, produto?.filhoUnicoId],
  );
  const estoque = useEstoqueDisponivel(db, produtoParaEstoque, depositoId);

  const qtyRef = useRef<HTMLInputElement>(null);

  async function handlePick(produtoPicked: Produto, produtoId: string) {
    if (!listaId) {
      notifications.show({
        color: 'red',
        message: 'Selecione uma tabela de preços para adicionar produtos',
      });
      return;
    }
    // ⚠️ The LINE names the sellable unit, which for a family of one is the
    // child (#1398). `sincronizarEstoquePedido` reserves and removes against
    // `item.produtoUid` with no read-through of its own, so a line naming the
    // wrapper would move stock on a produto that owns no rows — `aplicarPlano`
    // creates one at `0 + delta`, i.e. drives it negative from nothing.
    //
    // The denormalised fields below stay the MATCHED produto's on purpose: the
    // sole member copies `nome`/`sku` but not `gtin`, and NF-e needs at least
    // one of sku/gtin on the item.
    //
    // ⚠️ A KIT is NEVER resolved, and that is not an optimisation. A kit holds
    // no stock of its own — `calcularAlteracoesEstoque` expands it into its
    // COMPONENTS and decrements those (`estoquePlan.ts:95-99`) — so the only
    // thing the line needs from the produto it names is the composition. The
    // parent always has it; a sole member does not always, because
    // `planejarMembroUnico` copies `ehKit` and NOT `componentesKit`
    // (`upSoleMember.ts:191-211`). Binding such a child gives
    // `calcularAlteracoesEstoque` a produto with `ehKit: true` and no map, and
    // its `if (!componentes) continue;` then decrements NOTHING: the sale ships
    // with its components untouched and still sellable.
    //
    // Resolving buys a kit nothing and risks that, so it does not. The Balanço
    // refuses kits before resolving for the same reason (`classificarProduto`),
    // and the two paths now agree.
    const ehKitPicked = produtoPicked.ehKit === true;
    const alvo = ehKitPicked ? produtoId : unidadeVendavel({ ...produtoPicked, id: produtoId });
    const produtoUidDaLinha = await alvoQueRealmenteTemEstoque(db, produtoId, alvo, depositoId);
    form.setValue(`_itensFlat.${index}.produtoUid`, produtoUidDaLinha, {
      shouldDirty: true,
      shouldValidate: true,
    });
    form.setValue(`_itensFlat.${index}.sku`, produtoPicked.sku ?? null, { shouldDirty: true });
    // Carry the produto's GTIN too — NF-e needs at least one of sku/gtin, and a
    // GTIN-only produto would otherwise leave the item with neither.
    form.setValue(`_itensFlat.${index}.gtin`, produtoPicked.gtin ?? null, { shouldDirty: true });
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
    form.setValue(`_itensFlat.${index}.gtin`, null, { shouldDirty: true });
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
              <Anchor
                component={Link}
                href={`/produtos/${produtoUid}/editar`}
                target="_blank"
                rel="noopener noreferrer"
                size="xs"
                c="dimmed"
              >
                {produto?.sku ? `SKU: ${produto.sku}` : 'Sem SKU'}
              </Anchor>
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
            <DecimalInput
              ref={qtyRef}
              value={field.value ?? 0}
              onChange={(n) => field.onChange(n ?? 0)}
              onBlur={field.onBlur}
              min={0}
              decimalScale={3}
              w={100}
              disabled={disabled || marked}
              ariaLabel={`Quantidade item ${index + 1}`}
            />
          )}
        />
      </Table.Td>
      <Table.Td>
        <Controller
          control={form.control}
          name={`_itensFlat.${index}.precoDeVenda` as const}
          render={({ field }) => (
            <DecimalInput
              value={field.value ?? 0.01}
              onChange={(n) => field.onChange(n ?? 0.01)}
              onBlur={field.onBlur}
              min={0.01}
              decimalScale={2}
              w={120}
              disabled={disabled || marked}
              ariaLabel={`Preço item ${index + 1}`}
            />
          )}
        />
      </Table.Td>
      <Table.Td>
        <Controller
          control={form.control}
          name={`_itensFlat.${index}.descontoUnitario` as const}
          render={({ field }) => (
            <DecimalInput
              value={field.value ?? 0}
              onChange={(n) => field.onChange(n ?? 0)}
              onBlur={field.onBlur}
              min={0}
              decimalScale={2}
              w={120}
              disabled={disabled || marked}
              error={descontoError}
              ariaLabel={`Desconto item ${index + 1}`}
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

/**
 * The produto a line should NAME, given the one the resolution chose.
 *
 * ⚠️ Every READ surface in this stack carries an explicit escape hatch for one
 * state — `filhoUnicoId` records that the family has exactly one child and says
 * NOTHING about where the units sit, so a produto whose stock was lançado on the
 * parent and never moved still has the number there. `residualEstoquePai` is the
 * channel that surfaces it, and it expects a human to clear it.
 *
 * The WRITE side needs the same question asked, and cannot answer it the same
 * way. `sincronizarEstoquePedido` has no read-through: it reserves against
 * `est-<produtoUid>-<dep>` and `aplicarPlano` CREATES that row at `0 - qty`. So
 * a line bound to a child with no row, while the units sit on the parent, drives
 * one document negative from nothing and leaves the real units sellable — the
 * mirror of the failure the read fallback fixed.
 *
 * ⚠️ "The child has no row" is NOT sufficient on its own: a produto born as a
 * family of one (#1398) has no rows ANYWHERE until someone books stock, and that
 * stock goes to the child. So the parent wins only when it actually holds units
 * the child does not — exactly the state a human is expected to clear, and until
 * they do the line follows the stock rather than the invariant.
 *
 * Two reads, on a manual pick, and only when the resolution moved the id at all.
 */
async function alvoQueRealmenteTemEstoque(
  db: Firestore,
  produtoId: string,
  alvo: string,
  depositoId: string | null,
): Promise<string> {
  if (alvo === produtoId || !depositoId) return alvo;

  const ler = async (id: string): Promise<number> => {
    try {
      const snap = await getDoc(
        estoqueProdutoCollection.docRef(db, { produtoId: id }, makeEstoqueUid(id, depositoId)),
      );
      if (!snap.exists()) return 0;
      const disp = estoqueDisponivel(snap.data());
      return Number.isFinite(disp) ? disp : 0;
    } catch (err) {
      // A read failure must not silently change where the line binds: keep the
      // resolution the invariant asks for and let the sync surface any drift.
      if (err instanceof FirebaseError) return 0;
      throw err;
    }
  };

  const [doAlvo, doPai] = await Promise.all([ler(alvo), ler(produtoId)]);
  return doAlvo <= 0 && doPai > 0 ? produtoId : alvo;
}
