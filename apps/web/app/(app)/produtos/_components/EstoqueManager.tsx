'use client';

import { type FocusEvent, useMemo, useState } from 'react';
import { ActionIcon, Box, Divider, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import { getDocsFromServer, type Firestore } from 'firebase/firestore';
import {
  componentesKitEntries,
  estoqueDisponivel,
  estoqueDisponivelComKit,
  makeEstoqueUid,
  type ComponentesKit,
  type EstoqueProduto,
} from '@delfrance/schemas';
import { buildQuery, limit, orderByField, whereEqual } from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';
import { depositoCollection } from '@/lib/data/depositoCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { estoqueProdutoCollection } from '@/lib/data/estoqueProdutoCollection';
import { setEstoqueLocalizacao } from '@/lib/produtos/clientPort';
import { EstoqueMovimentacaoModal } from './EstoqueMovimentacaoModal';

// Depósitos and variation children are inherently few; bounded queries suffice.
const DEPOSITO_LIMIT = 200;
const ESTOQUE_LIMIT = 500;
const CHILDREN_LIMIT = 500;

interface ProdutoRow {
  id: string;
  nome: string | null;
  sku: string | null;
  ehKit: boolean;
  componentesKit: ComponentesKit | null;
}
interface DepositoRow {
  id: string;
  nome: string;
}

const fmt = (n: number) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const produtoLabel = (p: ProdutoRow): string => `${p.sku ?? 'Sem SKU'} - ${p.nome ?? 'Sem nome'}`;

/** Old-app filter: nome substring (case-insensitive) OR sku prefix. */
function matchesFilter(p: ProdutoRow, term: string): boolean {
  const t = term.toLowerCase();
  return (p.nome ?? '').toLowerCase().includes(t) || (p.sku ?? '').startsWith(term);
}

export interface EstoqueManagerProps {
  /** `null` in create mode — the produto must be saved before editing stock. */
  produtoId: string | null;
  db: Firestore;
  disabled?: boolean;
}

/**
 * Estoque por depósito tab (Flutter `EstoqueProdutosVariacoesWidget`). Lists the
 * parent produto plus each variation child (each a separate produto doc with its
 * own `estoques`), with a `<sku> - <nome>` header per produto, a filter, and
 * zebra-striped rows. Per (produto × depósito): inline `localizacao` (saved on
 * blur — a `localizacao`-only write) and a conflict-safe quantity editor modal.
 *
 * Self-contained — stock editing is decoupled from the parent form save (it spans
 * many produto docs), so this ignores the ObjectView field value/onChange.
 */
export function EstoqueManager({ produtoId, db, disabled }: EstoqueManagerProps) {
  // Active depósitos (bounded, name-ordered; `ativo` filtered client-side).
  const depositosQuery = useMemo(
    () => buildQuery(depositoCollection.ref(db, {}), [orderByField('nome'), limit(DEPOSITO_LIMIT)]),
    [db],
  );
  const depositosSnap = useSnapshot(depositosQuery);
  const depositos: DepositoRow[] = useMemo(
    () =>
      (depositosSnap.data ?? [])
        .filter((d) => d.data.ativo !== false)
        .map((d) => ({ id: d.id, nome: d.data.nome })),
    [depositosSnap.data],
  );

  // The parent produto + its variation children (each their own estoque docs).
  const parentRef = useMemo(
    () => (produtoId ? produtoCollection.docRef(db, {}, produtoId) : null),
    [db, produtoId],
  );
  const parentSnap = useDocSnapshot(parentRef);
  const childrenQuery = useMemo(
    () =>
      produtoId
        ? buildQuery(produtoCollection.ref(db, {}), [
            whereEqual('paiId', produtoId),
            limit(CHILDREN_LIMIT),
          ])
        : null,
    [db, produtoId],
  );
  const childrenSnap = useSnapshot(childrenQuery);

  const produtos: ProdutoRow[] = useMemo(() => {
    if (!produtoId || !parentSnap.data) return [];
    const parent: ProdutoRow = {
      id: produtoId,
      nome: parentSnap.data.data.nome ?? null,
      sku: parentSnap.data.data.sku ?? null,
      ehKit: parentSnap.data.data.ehKit === true,
      componentesKit: parentSnap.data.data.componentesKit ?? null,
    };
    const ordemOf = (d: { data: { ordem?: number | null } }) => d.data.ordem ?? 0;
    const children = (childrenSnap.data ?? [])
      .slice()
      .sort((a, b) => ordemOf(a) - ordemOf(b))
      .map((d) => ({
        id: d.id,
        nome: d.data.nome ?? null,
        sku: d.data.sku ?? null,
        ehKit: d.data.ehKit === true,
        componentesKit: d.data.componentesKit ?? null,
      }));
    return [parent, ...children];
  }, [produtoId, parentSnap.data, childrenSnap.data]);

  const [filter, setFilter] = useState('');

  if (!produtoId) {
    return (
      <Text c="dimmed" size="sm">
        Salve o produto antes de editar o estoque.
      </Text>
    );
  }
  if (depositosSnap.error) {
    return (
      <Text c="red" size="sm">
        Falha ao carregar depósitos: {depositosSnap.error.message}
      </Text>
    );
  }
  if (depositos.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        {depositosSnap.loading ? 'Carregando depósitos…' : 'Nenhum depósito ativo cadastrado.'}
      </Text>
    );
  }
  if (produtos.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        Carregando…
      </Text>
    );
  }

  const term = filter.trim();
  const filtering = term !== '';

  return (
    <Stack gap="xs">
      <TextInput
        label="Filtrar"
        placeholder="Nome ou SKU da variação"
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
      />
      {produtos.map((p, index) => {
        const highlight = filtering && matchesFilter(p, term);
        return (
          <EstoqueProdutoSection
            key={p.id}
            db={db}
            produto={p}
            depositos={depositos}
            disabled={disabled}
            zebra={index % 2 === 1}
            highlight={highlight}
            dimmed={filtering && !highlight}
          />
        );
      })}
    </Stack>
  );
}

interface SectionProps {
  db: Firestore;
  produto: ProdutoRow;
  depositos: DepositoRow[];
  disabled?: boolean;
  zebra: boolean;
  highlight: boolean;
  dimmed: boolean;
}

/** One produto (parent or variation) — its `<sku> - <nome>` header + depósito rows. */
function EstoqueProdutoSection({
  db,
  produto,
  depositos,
  disabled,
  zebra,
  highlight,
  dimmed,
}: SectionProps) {
  // Limit-only full fetch of one produto's estoques — no predicate/sort, so no
  // Firestore index applies; bounded by the number of depósitos (#407 audit).
  const estoquesQuery = useMemo(
    () =>
      buildQuery(estoqueProdutoCollection.ref(db, { produtoId: produto.id }), [
        limit(ESTOQUE_LIMIT),
      ]),
    [db, produto.id],
  );
  const estoquesSnap = useSnapshot(estoquesQuery);
  const byId = useMemo(() => {
    const map = new Map<string, EstoqueProduto>();
    for (const d of estoquesSnap.data ?? []) map.set(d.id, d.data);
    return map;
  }, [estoquesSnap.data]);

  // Kit sections also read each `limitarEstoque` component's estoques so the
  // Disponível cell can append the computed kit availability (Flutter
  // `getEstoqueDisponivel`, `produtoCadastro.dart:1885`). One-shot server reads
  // per countable component (small, picker-curated maps) — the 30s query
  // staleTime plays the role of the legacy 1-minute cache, so a component
  // stock moved elsewhere stays stale until refetch, same tradeoff.
  const countableIds = useMemo(
    () =>
      produto.ehKit
        ? componentesKitEntries(produto.componentesKit)
            .filter(([, kit]) => kit.limitarEstoque !== false)
            .map(([id]) => id)
            .sort()
        : [],
    [produto.ehKit, produto.componentesKit],
  );
  const kitEstoquesQuery = useQuery({
    queryKey: ['kitComponentEstoques', produto.id, countableIds],
    enabled: countableIds.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        countableIds.map(async (compId) => {
          const snap = await getDocsFromServer(
            buildQuery(estoqueProdutoCollection.ref(db, { produtoId: compId }), [
              limit(ESTOQUE_LIMIT),
            ]),
          );
          const byEstoqueId = new Map<string, number>();
          for (const doc of snap.docs) {
            const disp = estoqueDisponivel(doc.data());
            // Soft-parse can hand back junk quantities → NaN; drop the doc so
            // the pure helper counts the component as missing (= 0).
            if (Number.isFinite(disp)) byEstoqueId.set(doc.id, disp);
          }
          return [compId, byEstoqueId] as const;
        }),
      );
      return new Map(entries);
    },
  });
  const kit: KitInfo | null = produto.ehKit
    ? {
        componentesKit: produto.componentesKit,
        state:
          countableIds.length === 0
            ? 'ready'
            : kitEstoquesQuery.isError
              ? 'error'
              : kitEstoquesQuery.data
                ? 'ready'
                : 'loading',
        estoquesByComponentId: kitEstoquesQuery.data ?? null,
      }
    : null;

  const label = produtoLabel(produto);

  return (
    <Box
      bg={highlight ? 'yellow.1' : zebra ? 'gray.0' : undefined}
      style={{ opacity: dimmed ? 0.45 : 1, borderRadius: 4, padding: 8 }}
    >
      <Divider label={label} labelPosition="left" mb={6} />
      <Stack gap={4}>
        {depositos.map((dep) => {
          const est = byId.get(makeEstoqueUid(produto.id, dep.id));
          return (
            <EstoqueDepositoRow
              key={dep.id}
              db={db}
              produtoId={produto.id}
              produtoLabel={label}
              deposito={dep}
              estoque={est}
              kit={kit}
              disabled={disabled}
            />
          );
        })}
      </Stack>
    </Box>
  );
}

/** Kit context a section passes to its rows (`null` for non-kit produtos). */
interface KitInfo {
  componentesKit: ComponentesKit | null;
  state: 'loading' | 'error' | 'ready';
  /** Countable component produto id → (estoque doc id → finite `disponivel`). */
  estoquesByComponentId: ReadonlyMap<string, ReadonlyMap<string, number>> | null;
}

interface RowProps {
  db: Firestore;
  produtoId: string;
  produtoLabel: string;
  deposito: DepositoRow;
  estoque: EstoqueProduto | undefined;
  kit: KitInfo | null;
  disabled?: boolean;
}

/** One depósito row: nome | inline localização | qty | reservado | disponível | edit. */
function EstoqueDepositoRow({
  db,
  produtoId,
  produtoLabel,
  deposito,
  estoque,
  kit,
  disabled,
}: RowProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const quantidade = estoque?.quantidade ?? 0;
  const reservada = estoque?.quantidadeReservada ?? 0;
  const loc = estoque?.localizacao ?? '';
  const hasExisting = estoque !== undefined;
  // Re-mount the uncontrolled input when the persisted localização changes.
  const inputKey = `${deposito.id}:${loc}`;
  const ariaSuffix = `${produtoId} ${deposito.nome}`;

  const handleBlur = async (e: FocusEvent<HTMLInputElement>) => {
    const next = e.currentTarget.value.trim();
    if (next === loc.trim()) return;
    try {
      await setEstoqueLocalizacao({
        produtoId,
        depositoId: deposito.id,
        localizacao: next === '' ? null : next,
      });
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({
          color: 'red',
          title: 'Falha ao salvar a localização',
          message: err.message,
        });
        return;
      }
      throw err;
    }
  };

  return (
    <Group gap="sm" wrap="nowrap" align="center">
      <Text size="sm" style={{ flex: 2, minWidth: 0 }}>
        {deposito.nome}
      </Text>
      <TextInput
        key={inputKey}
        aria-label={`Localização ${ariaSuffix}`}
        placeholder="Localização"
        defaultValue={loc}
        onBlur={handleBlur}
        maxLength={50}
        disabled={disabled}
        size="xs"
        style={{ flex: 3 }}
      />
      <Text size="sm" ta="right" style={{ flex: 1 }}>
        {fmt(quantidade)}
      </Text>
      <Text size="sm" ta="right" style={{ flex: 1 }}>
        {fmt(reservada)}
      </Text>
      <DisponivelCell
        ownDisponivel={estoqueDisponivel({ quantidade, quantidadeReservada: reservada })}
        kit={kit}
        depositoId={deposito.id}
        ariaSuffix={ariaSuffix}
      />
      <Tooltip label="Editar estoque">
        <ActionIcon
          variant="subtle"
          aria-label={`Editar estoque ${ariaSuffix}`}
          onClick={() => setModalOpen(true)}
          disabled={disabled}
        >
          <IconPencil size={16} />
        </ActionIcon>
      </Tooltip>
      <EstoqueMovimentacaoModal
        opened={modalOpen}
        onClose={() => setModalOpen(false)}
        db={db}
        produtoId={produtoId}
        depositoId={deposito.id}
        produtoLabel={produtoLabel}
        depositoNome={deposito.nome}
        quantidade={quantidade}
        quantidadeReservada={reservada}
        hasExisting={hasExisting}
      />
    </Group>
  );
}

interface DisponivelCellProps {
  ownDisponivel: number;
  kit: KitInfo | null;
  depositoId: string;
  ariaSuffix: string;
}

/**
 * The Disponível value; kit produtos append the computed kit availability in
 * parens — own + what the components allow building — mirroring the Flutter
 * cell (`produtoCadastro.dart:1870-1897`, `(...)` while loading, `(Erro)` on
 * failure). Renders even when the kit's own estoque doc is missing (own = 0).
 */
function DisponivelCell({ ownDisponivel, kit, depositoId, ariaSuffix }: DisponivelCellProps) {
  let kitSuffix = '';
  if (kit) {
    if (kit.state === 'loading') kitSuffix = ' (...)';
    else if (kit.state === 'error') kitSuffix = ' (Erro)';
    else {
      const disponivelByProdutoId: Record<string, number | undefined> = {};
      for (const [compId] of componentesKitEntries(kit.componentesKit)) {
        disponivelByProdutoId[compId] = kit.estoquesByComponentId
          ?.get(compId)
          ?.get(makeEstoqueUid(compId, depositoId));
      }
      const total = estoqueDisponivelComKit(
        { ehKit: true, componentesKit: kit.componentesKit },
        ownDisponivel,
        disponivelByProdutoId,
      );
      kitSuffix = ` (${fmt(total)})`;
    }
  }
  return (
    <Text size="sm" ta="right" style={{ flex: 1 }} aria-label={`Disponível ${ariaSuffix}`}>
      {fmt(ownDisponivel)}
      {kitSuffix}
    </Text>
  );
}
