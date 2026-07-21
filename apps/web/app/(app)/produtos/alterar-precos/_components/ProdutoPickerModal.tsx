'use client';

/**
 * Product picker for the bulk manual price editor (#545) — port of the
 * legacy "Adicionar Produtos" dialog (`.old/lib/produtos/pages/alterarPrecoMassa.dart:26-126`,
 * `IncluirProdutosSelecionadosAction` / `IncluirProdutosFiltradosAction`).
 *
 * Deviations from legacy, deliberate:
 * - Legacy popped the dialog the instant either action fired. This modal
 *   stays open after "Incluir selecionados" / "Incluir todos os filtrados" so
 *   the user can keep searching and adding more — better UX for the same
 *   task. The selection Set is cleared after each inclusion (it always
 *   refers to *currently loaded* rows only — see below), so the caller sees
 *   fresh picks each time; the caller is responsible for deduping against
 *   what it already holds (a `Map<produtoId, …>` upstream — this component
 *   may legitimately emit the same produto twice across separate clicks,
 *   e.g. if the user re-searches and re-selects the same row).
 * - Legacy's "Incluir Produtos Filtrados" paged 500-at-a-time up to ~500k
 *   rows. This port caps at {@link CAP} (10,000) and surfaces a notification
 *   when the cap is hit, so a pathological filter (or none at all) can't
 *   pull the entire catalog into memory.
 * - Selection is cleared whenever the search identity (field or term)
 *   changes, not just after inclusion. Checkboxes only ever reflect rows
 *   that are currently loaded/visible — otherwise the "N selecionado(s)"
 *   counter could reference rows that scrolled out of the result set,
 *   which "Incluir selecionados" would then silently drop (it only ever
 *   reads from the currently loaded `rows`).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  ScrollArea,
  SegmentedControl,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { FirebaseError } from 'firebase/app';
import {
  type Firestore,
  type QueryConstraint,
  type QueryDocumentSnapshot,
  getDocs,
  startAfter,
} from 'firebase/firestore';
import { buildQuery, limit, orderByField, whereEqual, whereOp } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { formatReais } from '@delfrance/core/money';
import { idFromRef, type Produto } from '@delfrance/schemas';

import { getFirebaseFirestore } from '@/lib/firebase/client';
import { produtoCollection } from '@/lib/data/produtoCollection';
import {
  CATALOGO_PAGE,
  toProdutoPrecoRow,
  type ProdutoPrecoRow,
} from '@/lib/produtos/bulkPreco/loadCatalogo';

// U+F8FF: a very high private-use code point. Appended to the search term it
// bounds a prefix range (`field >= term && field <= term + sentinel`). Same
// convention as the /produtos catalog search (`page.tsx`'s `PREFIX_SENTINEL`).
const PREFIX_SENTINEL = '';

/** Initial + per-click growth of the live-query window (`limit`). */
const WINDOW_INITIAL = 50;
const WINDOW_STEP = 50;

/**
 * Hard cap for "Incluir todos os filtrados" — legacy had no real ceiling
 * (~500k via 500-row pages up to 1000 iterations). Capped here deliberately
 * so an unbounded/empty filter can't drag the entire catalog into memory.
 */
export const CAP = 10_000;

type SearchField = 'nome' | 'sku';

export interface ProdutoPickerModalProps {
  opened: boolean;
  onClose: () => void;
  onInclude: (rows: ProdutoPrecoRow[]) => void;
}

function isAbortError(err: unknown): err is DOMException {
  return err instanceof DOMException && err.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Carregamento cancelado', 'AbortError');
  }
}

/**
 * Same projection as `toProdutoPrecoRow` (loadCatalogo.ts), but adapted to the
 * `{ id, data }` shape `useSnapshot` returns for the live search window —
 * `toProdutoPrecoRow` itself takes a raw `QueryDocumentSnapshot` (`d.data()`
 * as a method), which the live-query rows aren't.
 */
function toRowFromSnapshotRow(id: string, p: Produto): ProdutoPrecoRow {
  return {
    id,
    sku: p.sku,
    nome: p.nome,
    custo: p.custo,
    precos: p.precos,
    categoriaId: p.categoriaProdutoOuterRef ? idFromRef(p.categoriaProdutoOuterRef) : null,
    pesoBrutoKg: p.pesoBrutoKg,
    pesoLiquidoKg: p.pesoLiquidoKg,
    ehKit: p.ehKit,
    componentesKit: p.componentesKit,
  };
}

/**
 * Cursor-paged bulk fetch for "Incluir todos os filtrados". NOT a call to the
 * shared `pageParentProdutos` (loadCatalogo.ts): that generator hardcodes
 * `orderByField('nome')`, which Firestore forbids combining with a range
 * filter on a *different* field (`sku`) — the first `orderBy` must match the
 * inequality's field. This mirrors its shape exactly (same `paiId` filter,
 * same cursor-via-last-doc pagination, same `toProdutoPrecoRow` projection)
 * but takes the already-built, field-correct constraint list instead.
 */
async function* pageFilteredProdutos(
  db: Firestore,
  constraints: QueryConstraint[],
  signal: AbortSignal,
): AsyncGenerator<ProdutoPrecoRow[]> {
  const baseQ = buildQuery(produtoCollection.ref(db, {}), constraints);
  let cursor: QueryDocumentSnapshot<Produto> | undefined;

  for (;;) {
    throwIfAborted(signal);
    const pageConstraints = cursor
      ? [limit(CATALOGO_PAGE), startAfter(cursor)]
      : [limit(CATALOGO_PAGE)];
    const snap = await getDocs(buildQuery(baseQ, pageConstraints));
    throwIfAborted(signal);
    if (snap.empty) break;
    const docs = snap.docs as QueryDocumentSnapshot<Produto>[];

    yield docs.map(toProdutoPrecoRow);

    if (docs.length < CATALOGO_PAGE) break;
    cursor = docs[docs.length - 1];
  }
}

export function ProdutoPickerModal({ opened, onClose, onInclude }: ProdutoPickerModalProps) {
  const db = useMemo(() => getFirebaseFirestore(), []);

  const [field, setField] = useState<SearchField>('nome');
  const [search, setSearch] = useState('');
  const [windowSize, setWindowSize] = useState(WINDOW_INITIAL);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingTodos, setLoadingTodos] = useState(false);
  const [carregadosTodos, setCarregadosTodos] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const trimmed = search.trim();

  // A new search identity (field or term) invalidates the current window's
  // selection — see the file-level comment on why selection never outlives
  // the rows it was made against.
  useEffect(() => {
    setWindowSize(WINDOW_INITIAL);
    setSelected(new Set());
  }, [field, trimmed]);

  // Reset everything on close (and cancel any in-flight bulk fetch) so the
  // next open starts clean.
  useEffect(() => {
    if (opened) return;
    abortRef.current?.abort();
    setSearch('');
    setField('nome');
    setWindowSize(WINDOW_INITIAL);
    setSelected(new Set());
    setLoadingTodos(false);
    setCarregadosTodos(0);
  }, [opened]);

  // Parent produtos only, empty term → plain nome-ordered listing. A
  // non-empty term must `orderBy` the SAME field it range-filters
  // (Firestore's inequality/orderBy coupling) — built manually per field
  // rather than through `produtoMeta.defaultQuery` (which fixes `orderBy` to
  // `nome`).
  const searchConstraints = useMemo((): QueryConstraint[] => {
    const orderField = trimmed ? field : 'nome';
    const constraints: QueryConstraint[] = [whereEqual('paiId', null), orderByField(orderField)];
    if (trimmed) {
      constraints.push(
        whereOp(field, '>=', trimmed),
        whereOp(field, '<=', `${trimmed}${PREFIX_SENTINEL}`),
      );
    }
    return constraints;
  }, [field, trimmed]);

  const listQuery = useMemo(
    () =>
      opened
        ? buildQuery(produtoCollection.ref(db, {}), [...searchConstraints, limit(windowSize)])
        : null,
    [db, opened, searchConstraints, windowSize],
  );
  const { data, loading, error } = useSnapshot(listQuery);
  const rows = data ?? [];

  const selectedLoadedCount = rows.filter((r) => selected.has(r.id)).length;
  const allLoadedSelected = rows.length > 0 && selectedLoadedCount === rows.length;
  const someLoadedSelected = selectedLoadedCount > 0 && !allLoadedSelected;

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleHeader() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allLoadedSelected) {
        for (const r of rows) next.delete(r.id);
      } else {
        for (const r of rows) next.add(r.id);
      }
      return next;
    });
  }

  function handleIncluirSelecionados() {
    const chosen = rows
      .filter((r) => selected.has(r.id))
      .map((r) => toRowFromSnapshotRow(r.id, r.data));
    if (chosen.length === 0) return;
    onInclude(chosen);
    setSelected(new Set());
  }

  async function handleIncluirFiltrados() {
    const controller = new AbortController();
    abortRef.current = controller;
    setLoadingTodos(true);
    setCarregadosTodos(0);

    const acc: ProdutoPrecoRow[] = [];
    let capped = false;
    try {
      for await (const page of pageFilteredProdutos(db, searchConstraints, controller.signal)) {
        acc.push(...page);
        setCarregadosTodos(acc.length);
        if (acc.length >= CAP) {
          capped = true;
          break;
        }
      }
    } catch (err) {
      if (isAbortError(err)) return;
      if (err instanceof FirebaseError) {
        notifications.show({
          color: 'red',
          title: 'Falha ao carregar produtos',
          message: err.message,
        });
        return;
      }
      throw err;
    } finally {
      setLoadingTodos(false);
    }

    if (capped) {
      notifications.show({
        color: 'yellow',
        message: 'Limite de 10.000 produtos atingido — refine o filtro',
      });
    }
    onInclude(acc.slice(0, CAP));
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Adicionar produtos" size="xl" centered>
      <Stack>
        <Group align="flex-end">
          <TextInput
            style={{ flex: 1 }}
            label="Buscar"
            placeholder={field === 'nome' ? 'Buscar por nome…' : 'Buscar por SKU…'}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            disabled={loadingTodos}
          />
          <SegmentedControl
            value={field}
            onChange={(value) => setField(value as SearchField)}
            disabled={loadingTodos}
            data={[
              { label: 'Nome', value: 'nome' },
              { label: 'SKU', value: 'sku' },
            ]}
          />
        </Group>

        {error && (
          <Alert color="red" title="Erro ao carregar produtos">
            {error.message}
          </Alert>
        )}

        <ScrollArea h={360} offsetScrollbars>
          <Table striped highlightOnHover stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ width: 36 }}>
                  <Checkbox
                    aria-label="Selecionar todos os carregados"
                    checked={allLoadedSelected}
                    indeterminate={someLoadedSelected}
                    disabled={rows.length === 0 || loadingTodos || loading}
                    onChange={toggleHeader}
                  />
                </Table.Th>
                <Table.Th>Nome</Table.Th>
                <Table.Th>SKU</Table.Th>
                <Table.Th>Custo</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {loading && (
                <Table.Tr>
                  <Table.Td colSpan={4}>
                    <Skeleton height={24} />
                  </Table.Td>
                </Table.Tr>
              )}
              {!loading && rows.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={4} align="center">
                    Nenhum produto encontrado.
                  </Table.Td>
                </Table.Tr>
              )}
              {!loading &&
                rows.map((r) => {
                  const p = r.data;
                  const checked = selected.has(r.id);
                  return (
                    <Table.Tr
                      key={r.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => toggleRow(r.id)}
                    >
                      <Table.Td onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          aria-label={`Selecionar ${p.nome}`}
                          checked={checked}
                          disabled={loadingTodos}
                          onChange={() => toggleRow(r.id)}
                        />
                      </Table.Td>
                      <Table.Td>{p.nome}</Table.Td>
                      <Table.Td>{p.sku ?? '—'}</Table.Td>
                      <Table.Td>{p.custo === null ? '—' : formatReais(p.custo)}</Table.Td>
                    </Table.Tr>
                  );
                })}
            </Table.Tbody>
          </Table>
        </ScrollArea>

        {!loading && rows.length > 0 && rows.length === windowSize && (
          <Group justify="center">
            <Button
              size="xs"
              variant="subtle"
              disabled={loadingTodos}
              onClick={() => setWindowSize((n) => n + WINDOW_STEP)}
            >
              Carregar mais
            </Button>
          </Group>
        )}

        <Group justify="space-between" wrap="wrap">
          <Text size="sm" c="dimmed">
            {selected.size} selecionado(s)
            {loadingTodos && ` — Carregados: ${carregadosTodos}`}
          </Text>
          <Group>
            <Button
              variant="default"
              loading={loadingTodos}
              onClick={() => void handleIncluirFiltrados()}
            >
              Incluir todos os filtrados
            </Button>
            <Button
              disabled={selected.size === 0 || loadingTodos}
              onClick={handleIncluirSelecionados}
            >
              Incluir selecionados
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
