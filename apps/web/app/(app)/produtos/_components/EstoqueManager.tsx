'use client';

import { type FocusEvent, useMemo, useState } from 'react';
import { ActionIcon, Box, Divider, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import { estoqueDisponivel, makeEstoqueUid, type EstoqueProduto } from '@delfrance/schemas';
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
    };
    const ordemOf = (d: { data: { ordem?: number | null } }) => d.data.ordem ?? 0;
    const children = (childrenSnap.data ?? [])
      .slice()
      .sort((a, b) => ordemOf(a) - ordemOf(b))
      .map((d) => ({ id: d.id, nome: d.data.nome ?? null, sku: d.data.sku ?? null }));
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
              disabled={disabled}
            />
          );
        })}
      </Stack>
    </Box>
  );
}

interface RowProps {
  db: Firestore;
  produtoId: string;
  produtoLabel: string;
  deposito: DepositoRow;
  estoque: EstoqueProduto | undefined;
  disabled?: boolean;
}

/** One depósito row: nome | inline localização | qty | reservado | disponível | edit. */
function EstoqueDepositoRow({
  db,
  produtoId,
  produtoLabel,
  deposito,
  estoque,
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
      await setEstoqueLocalizacao(db, {
        produtoId,
        depositoId: deposito.id,
        localizacao: next === '' ? null : next,
        hasExisting,
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
      <Text size="sm" ta="right" style={{ flex: 1 }}>
        {fmt(estoqueDisponivel({ quantidade, quantidadeReservada: reservada }))}
      </Text>
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
