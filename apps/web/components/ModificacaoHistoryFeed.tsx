'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon, Alert, Badge, Box, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { type Firestore, getDocs } from 'firebase/firestore';
import {
  buildQuery,
  limit,
  orderByField,
  paginate,
  type CollectionHandle,
  type PathContext,
} from '@delfrance/data';
import { useSnapshotWithDocs, type SnapshotRow } from '@delfrance/data/hooks';
import { TRUNCATED_VALUE_KEY } from '@delfrance/core';
import { microsToDate } from '@delfrance/core/datetime';
import type { HistoricoModificacao, historicoModificacaoSchema } from '@delfrance/schemas';
import { UsuarioNome, uidFromUsuarioRef, useUsuarioNomes } from './UsuarioNome';

/**
 * Read-only, newest-first feed of a document's unified `historicoDeModificacoes`
 * entries — the shared body behind the produto "Modificações" tab and the pedido
 * one.
 *
 * Parameterized by the collection handle + its path context rather than by an
 * owner id, so the same component serves `produtos/{id}/…` and
 * `pedidos/{id}/…`. Everything owner-specific is injected:
 * `subcolecaoLabels` names the child collections in pt-BR, and
 * `renderFieldActions` contributes per-field controls (produto passes its
 * "Restaurar" button; pedido passes nothing and is therefore read-only).
 *
 * Page 1 is a realtime query (`useSnapshotWithDocs`) so a save surfaces the
 * trigger-written entry without a reload (#661). Deeper pages are one-shot
 * `getDocs` with snapshot cursors. Expanding a row reuses the `changes` map
 * already on the streamed doc — no second read.
 *
 * ⚠️ The live-window/tail machinery below (generation guard, eviction bridge,
 * merge) is subtle and was arrived at through two bug fixes; it is moved here
 * verbatim rather than reimplemented.
 */

/** Newest-first page size for both the live window and "Carregar mais". */
const DEFAULT_PAGE_SIZE = 50;

type Kind = 'create' | 'update' | 'delete';

/**
 * One row of the list. Classic `onSnapshot` / `getDocs` already carry the full
 * doc (incl. `changes`), so expand reuses that map instead of a second `getDoc`.
 */
export interface ListEntry {
  id: string;
  path: string;
  subcolecao: string | null;
  docId: string;
  kind: Kind;
  campos: string[];
  timestamp: number | null;
  changes: Record<string, { old: unknown; new: unknown }>;
  /** Absent when the row predates the actor field — NOT the same as `null`. */
  usuarioOuterRef: string | null | undefined;
  /** Present on live + load-more rows that still hold a cursor for pagination. */
  snap?: SnapshotRow<HistoricoModificacao>['snap'];
  /**
   * INJECTED rows only. The id of the history entry that would make this row
   * redundant; the feed hides it when that entry is actually loaded.
   *
   * Deduping against what is PRESENT rather than against a proxy for "the
   * trigger must have covered this" is what keeps the pre-deploy window
   * honest — see `ModificacoesTab.legacyEstadoEntries`.
   */
  supersededByEntryId?: string | null;
}

const KIND_LABELS: Record<Kind, string> = {
  create: 'criação',
  update: 'edição',
  delete: 'exclusão',
};
const KIND_COLORS: Record<Kind, string> = { create: 'green', update: 'blue', delete: 'red' };

const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/** How many `campos` to show before collapsing to a `+N` — an expanded `itens`
 *  diff can carry a hundred fine keys, which would make the header unreadable. */
const CAMPOS_PREVIEW = 6;

function isTruncationSentinel(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[TRUNCATED_VALUE_KEY] === true
  );
}

/** Generic value renderer — compact JSON for objects/arrays, plain `String()` for scalars. */
export function renderValue(value: unknown): string {
  if (isTruncationSentinel(value)) return 'valor grande demais para exibir';
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (err) {
      // `JSON.stringify` throws a `TypeError` on a `BigInt` (or, in principle,
      // a circular structure — not expected from Firestore data, but this
      // stays defensive). Anything else is unexpected and must surface.
      if (err instanceof TypeError) return String(value);
      throw err;
    }
  }
  return String(value);
}

function rowToEntry(row: SnapshotRow<HistoricoModificacao>): ListEntry {
  const data = row.data;
  return {
    id: row.id,
    path: data.path,
    subcolecao: data.subcolecao ?? null,
    docId: data.docId,
    kind: data.kind,
    campos: data.campos ?? [],
    timestamp: typeof data.timestamp === 'number' ? data.timestamp : null,
    changes: data.changes ?? {},
    // Deliberately NOT `?? null`: absent and null mean different things.
    usuarioOuterRef: data.usuarioOuterRef,
    snap: row.snap,
  };
}

export interface ModificacaoHistoryFeedProps {
  db: Firestore;
  /** The owning root's history handle (produto's or pedido's). */
  collection: CollectionHandle<typeof historicoModificacaoSchema>;
  /** Resolves the handle's parent wildcard: `{ produtoId }` or `{ pedidoId }`. */
  ctx: PathContext;
  /**
   * pt-BR label per `subcolecao` value. A row whose `subcolecao` is null is the
   * root document itself and uses the `''` key. Falls back to the raw id.
   */
  subcolecaoLabels?: Readonly<Record<string, string>>;
  /**
   * Trailing controls for one field change. Produto passes its "Restaurar"
   * button; pedido passes nothing, which is what makes it read-only.
   */
  renderFieldActions?: (
    entry: ListEntry,
    field: string,
    change: { old: unknown; new: unknown },
  ) => ReactNode;
  emptyLabel?: string;
  pageSize?: number;
  /**
   * Rows from ANOTHER source to interleave into the same timeline, sorted with
   * the rest by `timestamp`.
   *
   * The pedido tab uses this for the `historicoEstadoPedido` rows: once the
   * trigger ships, an estado change is recorded HERE as an ordinary field, so
   * replaying the trail unconditionally would double every covered transition.
   * A row states its own redundancy via `supersededByEntryId` and is hidden only
   * when that entry is actually loaded — the caller does not have to predict
   * what this collection covers.
   *
   * ⚠️ They carry no snapshot cursor and are typically the OLDEST rows, so they
   * are excluded from `ownEntries` and take no part in pagination.
   */
  extraEntries?: ReadonlyArray<ListEntry>;
}

export function ModificacaoHistoryFeed({
  db,
  collection,
  ctx,
  subcolecaoLabels,
  renderFieldActions,
  emptyLabel = 'Nenhuma modificação registrada.',
  pageSize = DEFAULT_PAGE_SIZE,
  extraEntries,
}: ModificacaoHistoryFeedProps) {
  // Identity of the document being viewed — the reset effect below keys on it,
  // and a plain object would be a new reference on every render.
  const ctxKey = JSON.stringify(ctx);

  const liveQuery = useMemo(
    () => buildQuery(collection.ref(db, ctx), [orderByField('timestamp', 'desc'), limit(pageSize)]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ctxKey stands in for ctx
    [db, collection, ctxKey, pageSize],
  );

  const live = useSnapshotWithDocs<HistoricoModificacao>(liveQuery);

  const [extraRows, setExtraRows] = useState<SnapshotRow<HistoricoModificacao>[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Bumped on identity change so an in-flight `handleLoadMore` that resolves
  // after a document switch is ignored (won't append into the new state).
  const loadGenRef = useRef(0);
  // Previous live page — used to bridge docs that fall out of the pageSize
  // window into the one-shot tail after the user has already loaded more.
  const prevLiveRef = useRef<SnapshotRow<HistoricoModificacao>[]>([]);

  // Drop the one-shot tail when the document (or db) identity changes so a
  // previous document's paged history never bleeds into the next.
  useEffect(() => {
    loadGenRef.current += 1;
    prevLiveRef.current = [];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on identity change
    setExtraRows([]);
    setExhausted(false);
    setLoadingMore(false);
    setExpandedId(null);
  }, [db, ctxKey]);

  // When a new entry arrives, the live limit window slides and the oldest live
  // doc is dropped from `live.data`. If the user already paged, that evicted doc
  // is not in `extraRows` either — it would vanish. Bridge it into the tail so
  // the list stays continuous. A pure live window (no tail yet) stays sliding.
  useEffect(() => {
    const next = live.data ?? [];
    const prev = prevLiveRef.current;
    prevLiveRef.current = next;
    if (prev.length === 0 || next.length === 0) return;

    const nextIds = new Set(next.map((r) => r.id));
    const evicted = prev.filter((r) => !nextIds.has(r.id));
    if (evicted.length === 0) return;

    setExtraRows((tail) => {
      if (tail.length === 0) return tail;
      const seen = new Set(tail.map((r) => r.id));
      const bridge = evicted.filter((r) => !seen.has(r.id));
      if (bridge.length === 0) return tail;
      // Evicted sit between the live window and the older one-shot pages.
      return [...bridge, ...tail.filter((r) => !nextIds.has(r.id))];
    });
  }, [live.data]);

  // Live page first (authoritative + fresh), then the one-shot tail with any
  // id already surfaced live dropped.
  /**
   * Rows that came from THIS collection — the only ones that can be paginated.
   *
   * ⚠️ Kept separate from the rendered list on purpose. `extraEntries` carry no
   * snapshot cursor and are, by construction, the OLDEST rows in the feed (the
   * pedido tab injects exactly the pre-trigger estado rows), so they always sort
   * last. Deriving the cursor or `hasMore` from the merged list would take a
   * cursor-less row as the anchor and silently disable "Carregar mais" on every
   * pedido that has any legacy history.
   */
  const ownEntries = useMemo(() => {
    const liveRows = (live.data ?? []).map(rowToEntry);
    const seen = new Set(liveRows.map((r) => r.id));
    const tail = extraRows.filter((r) => !seen.has(r.id)).map(rowToEntry);
    return [...liveRows, ...tail];
  }, [live.data, extraRows]);

  const entries = useMemo(() => {
    if (!extraEntries || extraEntries.length === 0) return ownEntries;
    // Hide an injected row only when the entry it duplicates is really here.
    const ownIds = new Set(ownEntries.map((e) => e.id));
    const kept = extraEntries.filter(
      (e) => e.supersededByEntryId == null || !ownIds.has(e.supersededByEntryId),
    );
    if (kept.length === 0) return ownEntries;
    // Interleave the injected rows by time. Both inputs are already
    // newest-first, so this only has to merge them; a missing timestamp sorts
    // last rather than jumping to the top.
    const at = (e: ListEntry) => e.timestamp ?? Number.NEGATIVE_INFINITY;
    return [...ownEntries, ...kept].sort((a, b) => at(b) - at(a));
  }, [ownEntries, extraEntries]);

  // One batched resolution wave for every actor on screen.
  const nomes = useUsuarioNomes(
    useMemo(
      () =>
        entries.map((e) => uidFromUsuarioRef(e.usuarioOuterRef)).filter((u): u is string => !!u),
      [entries],
    ),
  );

  // Both keyed on OWN rows: the injected ones can neither be paged nor anchor a
  // cursor, so counting them here offered a button that could do nothing.
  const hasMore = !exhausted && ownEntries.length >= pageSize;
  const loading = live.loading;
  const listError = live.error ? `Falha ao carregar o histórico: ${live.error.code}` : null;

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || exhausted) return;
    // Capture cursor at click time so a concurrent live update can't shift
    // the pagination anchor mid-request.
    const cursor = ownEntries[ownEntries.length - 1]?.snap;
    if (!cursor) return;

    const gen = loadGenRef.current;
    setLoadingMore(true);
    try {
      const pageQuery = buildQuery(collection.ref(db, ctx), [
        orderByField('timestamp', 'desc'),
        ...paginate({ after: cursor, pageSize }),
      ]);
      const snap = await getDocs(pageQuery);
      // Identity changed while we were in flight — drop the result.
      if (gen !== loadGenRef.current) return;
      const newRows: SnapshotRow<HistoricoModificacao>[] = snap.docs.map((d) => ({
        id: d.id,
        path: d.ref.path,
        data: d.data(),
        snap: d,
      }));
      setExtraRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...newRows.filter((r) => !seen.has(r.id))];
      });
      if (newRows.length < pageSize) setExhausted(true);
    } catch (err) {
      if (gen !== loadGenRef.current) return;
      if (err instanceof FirebaseError) {
        notifications.show({
          color: 'red',
          message: `Falha ao carregar mais modificações: ${err.code}`,
        });
        return;
      }
      throw err;
    } finally {
      if (gen === loadGenRef.current) setLoadingMore(false);
    }
  }, [loadingMore, exhausted, ownEntries, db, collection, ctx, pageSize]);

  return (
    <Stack gap="md">
      {listError && <Alert color="red">{listError}</Alert>}
      {!listError && loading && <Loader size="sm" />}
      {!listError && !loading && entries.length === 0 && (
        <Text size="sm" c="dimmed">
          {emptyLabel}
        </Text>
      )}
      {entries.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          expanded={expandedId === entry.id}
          nomes={nomes}
          subcolecaoLabels={subcolecaoLabels}
          renderFieldActions={renderFieldActions}
          onToggle={() => setExpandedId((id) => (id === entry.id ? null : entry.id))}
        />
      ))}
      {!loading && !listError && hasMore && (
        <Button
          variant="subtle"
          size="xs"
          onClick={() => void handleLoadMore()}
          loading={loadingMore}
        >
          Carregar mais
        </Button>
      )}
    </Stack>
  );
}

interface EntryRowProps {
  entry: ListEntry;
  expanded: boolean;
  nomes: Record<string, string>;
  subcolecaoLabels?: Readonly<Record<string, string>>;
  renderFieldActions?: ModificacaoHistoryFeedProps['renderFieldActions'];
  onToggle: () => void;
}

function EntryRow({
  entry,
  expanded,
  nomes,
  subcolecaoLabels,
  renderFieldActions,
  onToggle,
}: EntryRowProps) {
  const origem = subcolecaoLabels
    ? (subcolecaoLabels[entry.subcolecao ?? ''] ?? entry.subcolecao ?? '')
    : entry.subcolecao;
  const alvo = origem ? `${origem} · ${entry.docId.slice(0, 8)}` : entry.docId;

  const campos = entry.campos;
  const camposLabel =
    campos.length > CAMPOS_PREVIEW
      ? `${campos.slice(0, CAMPOS_PREVIEW).join(', ')} +${campos.length - CAMPOS_PREVIEW}`
      : campos.join(', ');

  return (
    <Box
      data-testid="modificacao-entry"
      style={{ borderBottom: '1px solid var(--mantine-color-gray-3)' }}
      pb="xs"
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="wrap">
          <Badge color={KIND_COLORS[entry.kind]} variant="light">
            {KIND_LABELS[entry.kind]}
          </Badge>
          <Text size="sm" c="dimmed">
            {entry.timestamp ? dateFmt.format(microsToDate(entry.timestamp)) : '—'}
          </Text>
          <Text size="sm">{alvo}</Text>
          <UsuarioNome outerRef={entry.usuarioOuterRef} nomes={nomes} />
          {campos.length > 0 && (
            <Text size="xs" c="dimmed">
              Campos: {camposLabel}
            </Text>
          )}
        </Group>
        <ActionIcon variant="subtle" onClick={onToggle} aria-label="Detalhes da modificação">
          {expanded ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
        </ActionIcon>
      </Group>
      {expanded && (
        <Box mt="xs" ml="md">
          <Stack gap="xs">
            {Object.entries(entry.changes).map(([field, change]) => (
              <Group key={field} gap="xs" wrap="wrap" align="center">
                <Text size="sm" fw={500} style={{ minWidth: 140, wordBreak: 'break-all' }}>
                  {field}
                </Text>
                <Text size="sm">
                  {renderValue(change.old)} → {renderValue(change.new)}
                </Text>
                {renderFieldActions?.(entry, field, change)}
              </Group>
            ))}
            {Object.keys(entry.changes).length === 0 && (
              <Text size="xs" c="dimmed">
                Sem detalhes de campos para esta entrada.
              </Text>
            )}
          </Stack>
        </Box>
      )}
    </Box>
  );
}
