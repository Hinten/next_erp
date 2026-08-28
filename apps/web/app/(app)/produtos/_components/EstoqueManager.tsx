'use client';

import { type FocusEvent, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Box,
  Divider,
  Group,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconAlertTriangle, IconPencil } from '@tabler/icons-react';
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

/**
 * Whether a parent produto still holds stock of its own, and how much.
 *
 * ⚠️ Deliberately NOT `estoqueDisponivel`: a doc with `quantidade 3 /
 * quantidadeReservada 3` has `disponivel 0` and is still a residual — that is
 * exactly the shape the ML UP sole-member migration leaves behind on purpose
 * (`upSoleMember.ts:246-262` moves only the AVAILABLE units and expects a human
 * to find the reserved ones). A non-finite stored value counts as a residual
 * too: failing toward *visible* is the safe direction, since the alternative is
 * hiding units that nothing else in this app surfaces.
 */
export interface ResidualEstoque {
  temResidual: boolean;
  quantidade: number;
  reservada: number;
}

export function residualEstoquePai(
  estoques: Iterable<Pick<EstoqueProduto, 'quantidade' | 'quantidadeReservada'>>,
): ResidualEstoque {
  let temResidual = false;
  let quantidade = 0;
  let reservada = 0;
  for (const e of estoques) {
    const q = e.quantidade;
    const r = e.quantidadeReservada;
    if (!Number.isFinite(q) || !Number.isFinite(r)) {
      temResidual = true;
      continue;
    }
    if (q !== 0 || r !== 0) temResidual = true;
    quantidade += q;
    reservada += r;
  }
  return { temResidual, quantidade, reservada };
}

/** Just the amounts — both halves matter, and either can be zero. */
function descreverQuantidades(r: ResidualEstoque): string {
  const partes: string[] = [];
  if (r.quantidade !== 0) partes.push(`${fmt(r.quantidade)} em estoque`);
  if (r.reservada !== 0) partes.push(`${fmt(r.reservada)} reservada(s)`);
  // Non-finite quantities land here: real stock, no number worth printing.
  return partes.length === 0 ? 'estoque lançado' : partes.join(' e ');
}

/**
 * The alert's sentence(s). Units in a depósito the tab does not render — one
 * deactivated since the stock landed — get their own sentence: they are real
 * and must stay visible, but there is no row to move them from, so telling the
 * operator to move them would be an instruction the screen cannot honour.
 */
function descreverResidual(movivel: ResidualEstoque, inacessivel: ResidualEstoque): string {
  const frases: string[] = [];
  if (movivel.temResidual) {
    frases.push(
      `Há ${descreverQuantidades(movivel)} no produto pai — mova as unidades para a variação correspondente.`,
    );
  }
  if (inacessivel.temResidual) {
    frases.push(
      `Há ${descreverQuantidades(inacessivel)} no produto pai em depósito(s) inativo(s) — reative o depósito para poder movimentá-las.`,
    );
  }
  return frases.join(' ');
}

/**
 * One produto's `estoques`. Limit-only full fetch — no predicate/sort, so no
 * Firestore index applies; bounded by the number of depósitos (#407 audit).
 *
 * Lifted out of the section so the manager can read the PARENT's numbers to
 * decide the layout while keeping exactly ONE listener on them: the parent
 * section is handed the result instead of subscribing again.
 */
function useEstoquesDoProduto(db: Firestore, produtoId: string | null) {
  const query = useMemo(
    () =>
      produtoId
        ? buildQuery(estoqueProdutoCollection.ref(db, { produtoId }), [limit(ESTOQUE_LIMIT)])
        : null,
    [db, produtoId],
  );
  const snap = useSnapshot(query);
  const byId = useMemo(() => {
    const map = new Map<string, EstoqueProduto>();
    for (const d of snap.data ?? []) map.set(d.id, d.data);
    return map;
  }, [snap.data]);
  return { byId, loaded: snap.data !== undefined, error: snap.error };
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
 *
 * ⚠️ When the produto HAS variations, stock belongs on the children, so the
 * parent's own section is hidden behind a discreet toggle — but only once its
 * estoques are known to be EMPTY. The parent doc is not inert: Mercado Livre
 * never *sends* its quantity for a produto with variations
 * (`itemPayload.ts:243-247`, `bulkEstoquePlan.ts:1994-2013`), yet
 * `sincronizarEstoquePedido` still reserves against it, the Balanço still counts
 * it, and the UP sole-member migration deliberately strands reserved units there.
 * A residual is therefore surfaced as a warning and stays fully EDITABLE —
 * disabling it would make those units unmovable from the UI, which is worse than
 * showing them.
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

  const paiEstoques = useEstoquesDoProduto(db, produtoId);
  // Split by whether the tab actually renders a row for that depósito: only the
  // ACTIVE ones are listed, so stock in a deactivated depósito is real but has
  // nowhere on this screen to be moved from.
  const residual = useMemo(() => {
    const renderizados = new Set(depositos.map((d) => makeEstoqueUid(produtoId ?? '', d.id)));
    const movivel: EstoqueProduto[] = [];
    const inacessivel: EstoqueProduto[] = [];
    for (const [id, e] of paiEstoques.byId) {
      (renderizados.has(id) ? movivel : inacessivel).push(e);
    }
    return {
      movivel: residualEstoquePai(movivel),
      inacessivel: residualEstoquePai(inacessivel),
    };
  }, [paiEstoques.byId, depositos, produtoId]);
  const temResidual = residual.movivel.temResidual || residual.inacessivel.temResidual;

  const [filter, setFilter] = useState('');
  const [mostrarPai, setMostrarPai] = useState(false);

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
  const [parent, ...children] = produtos;
  // BOTH listeners must have answered before the layout is decided. The
  // variations query resolves independently of the parent doc's, and reading its
  // unresolved state as "no variations" renders the parent only to rip it away
  // when the children land — the same flash `paiEstoques.loaded` prevents below,
  // reached through the other listener. A query ERROR degrades to visible.
  if (!parent || (childrenSnap.data === undefined && !childrenSnap.error)) {
    return (
      <Text c="dimmed" size="sm">
        Carregando…
      </Text>
    );
  }

  const term = filter.trim();
  const filtering = term !== '';

  const temVariacoes = children.length > 0;
  // Hidden while the parent's estoques are still UNKNOWN too, so the section is
  // never shown and then yanked away. A read error degrades to the old
  // always-visible behaviour rather than hiding on a guess.
  const paiEscondido = temVariacoes && !paiEstoques.error && !(paiEstoques.loaded && temResidual);
  const mostrarToggle = paiEscondido && paiEstoques.loaded;
  const mostrarAlerta = temVariacoes && !paiEstoques.error && paiEstoques.loaded && temResidual;

  // Zebra runs over the RENDERED order, not `produtos` — otherwise dropping the
  // parent flips every stripe.
  const renderSection = (p: ProdutoRow, index: number, ehPai: boolean) => {
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
        estoquesById={ehPai ? paiEstoques.byId : undefined}
        paiComVariacoes={ehPai && temVariacoes}
      />
    );
  };

  return (
    <Stack gap="xs">
      <TextInput
        label="Filtrar"
        placeholder="Nome ou SKU da variação"
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
      />
      {mostrarAlerta && (
        <Alert
          color="yellow"
          icon={<IconAlertTriangle size={16} />}
          title="Estoque lançado no produto pai"
        >
          Este produto tem variações — o estoque deve ficar nas variações.{' '}
          {descreverResidual(residual.movivel, residual.inacessivel)}
        </Alert>
      )}
      {!paiEscondido && renderSection(parent, 0, true)}
      {children.map((c, i) => renderSection(c, paiEscondido ? i : i + 1, false))}
      {mostrarToggle && (
        <Anchor
          component="button"
          type="button"
          c="dimmed"
          size="sm"
          ta="left"
          onClick={() => setMostrarPai((v) => !v)}
        >
          {mostrarPai ? 'Ocultar estoque do produto pai' : 'Mostrar estoque do produto pai'}
        </Anchor>
      )}
      {mostrarToggle && mostrarPai && renderSection(parent, children.length, true)}
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
  /** Pre-loaded estoques (the parent's, already read once by the manager). */
  estoquesById?: ReadonlyMap<string, EstoqueProduto>;
  /** Suffixes the header with `(produto pai)` so a revealed parent reads as one. */
  paiComVariacoes?: boolean;
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
  estoquesById,
  paiComVariacoes,
}: SectionProps) {
  // Skipped entirely when the caller already holds this produto's estoques —
  // `useEstoquesDoProduto` above is the same query, and one listener is enough.
  const externo = estoquesById !== undefined;
  const estoquesQuery = useMemo(
    () =>
      externo
        ? null
        : buildQuery(estoqueProdutoCollection.ref(db, { produtoId: produto.id }), [
            limit(ESTOQUE_LIMIT),
          ]),
    [db, produto.id, externo],
  );
  const estoquesSnap = useSnapshot(estoquesQuery);
  const ownById = useMemo(() => {
    const map = new Map<string, EstoqueProduto>();
    for (const d of estoquesSnap.data ?? []) map.set(d.id, d.data);
    return map;
  }, [estoquesSnap.data]);
  const byId = estoquesById ?? ownById;

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

  const label = paiComVariacoes ? `${produtoLabel(produto)} (produto pai)` : produtoLabel(produto);

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
