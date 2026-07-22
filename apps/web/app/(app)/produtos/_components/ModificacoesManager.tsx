'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowBackUp, IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { type DocumentSnapshot, type Firestore, getDoc, getDocs } from 'firebase/firestore';
import { execute } from 'firebase/firestore/pipelines';
import { ZodError } from 'zod';
import {
  PIPELINE_ID_FIELD,
  PipelineUnsupportedError,
  buildPipeline,
  buildQuery,
  isPipelineSupported,
  orderByField,
  paginate,
} from '@delfrance/data';
import { TRUNCATED_VALUE_KEY } from '@delfrance/core';
import { microsToDate } from '@delfrance/core/datetime';
import { historicoModificacoesCollection } from '@/lib/data/historicoModificacoesCollection';
import { applyRevert, checkRevert, isRevertible, type RevertTarget } from '@/lib/produtos/revert';

/** Newest-first page size for both the list fetch and "Carregar mais". */
const PAGE_SIZE = 50;

/**
 * The Firestore JS SDK registers `db.pipeline()` on every Firestore instance
 * (it's a client-side method, side-effect-imported from
 * `firebase/firestore/pipelines`) regardless of what backend it's connected
 * to — so `isPipelineSupported(db)` returns `true` even against the Firebase
 * Emulator Suite, which does not implement the Pipelines RPC at all (see the
 * `firestore-pipelines` skill, §5/§7). The build-time emulator flag (same one
 * `lib/firebase/client.ts` uses to decide whether to call
 * `connectFirestoreEmulator`) is the only deterministic signal that
 * `isPipelineSupported` can't give us — gate on it explicitly instead of
 * guessing at a runtime error code from the failed RPC.
 */
const USING_FIRESTORE_EMULATOR = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === 'true';

type Kind = 'create' | 'update' | 'delete';

/** One row of the (light) list — no `changes`, so a big map never crosses the wire. */
interface ListEntry {
  id: string;
  path: string;
  subcolecao: string | null;
  docId: string;
  kind: Kind;
  campos: string[];
  timestamp: number | null;
}

/** A list entry's full doc, lazy-loaded on expand — adds the `changes` map. */
interface FullEntry extends ListEntry {
  status: 'ready';
  changes: Record<string, { old: unknown; new: unknown }>;
}

/** Discriminated on `status` so narrowing (`full.status === 'ready'`) is sound. */
type FullEntryState = { status: 'loading' } | { status: 'error'; message: string } | FullEntry;

interface ConflictState {
  entryId: string;
  field: string;
  target: RevertTarget;
  currentValue: unknown;
}

const KIND_LABELS: Record<Kind, string> = {
  create: 'criação',
  update: 'edição',
  delete: 'exclusão',
};
const KIND_COLORS: Record<Kind, string> = { create: 'green', update: 'blue', delete: 'red' };

const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function isTruncationSentinel(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[TRUNCATED_VALUE_KEY] === true
  );
}

/** Generic value renderer — compact JSON for objects/arrays, plain `String()` for scalars. */
function renderValue(value: unknown): string {
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

/**
 * Pipelines have no `startAfter` cursor, so paging filters `timestamp <
 * last-loaded`. Entries sharing that exact millisecond are skipped by the
 * next page — accepted for this path (CloudEvent times; two same-produto
 * writes in the same ms are rare). The classic path below pages exactly, via
 * a document-snapshot cursor.
 */
async function fetchListViaPipeline(
  db: Firestore,
  produtoId: string,
  before: number | null,
): Promise<ListEntry[]> {
  const pipeline = buildPipeline(db, {
    collection: historicoModificacoesCollection.resolvePath({ produtoId }),
    filters:
      before !== null ? [{ field: 'timestamp', op: 'lt' as const, value: before }] : undefined,
    orderBy: [{ field: 'timestamp', direction: 'desc' }],
    select: ['path', 'subcolecao', 'docId', 'kind', 'campos', 'timestamp'],
    limit: PAGE_SIZE,
  });
  const snap = await execute(pipeline);
  return snap.results.map((r) => {
    const data = r.data() as Record<string, unknown>;
    // `.select()` strips `PipelineResult.ref`; the id survives as the
    // PIPELINE_ID_FIELD projection `buildPipeline` appends (mirrors
    // `ProdutoHistoryButton`/`usePipelineSnapshot`'s row-reading pattern).
    const projectedId =
      typeof data[PIPELINE_ID_FIELD] === 'string' ? (data[PIPELINE_ID_FIELD] as string) : undefined;
    if (PIPELINE_ID_FIELD in data) delete data[PIPELINE_ID_FIELD];
    return {
      id: r.ref?.id ?? r.id ?? projectedId ?? '',
      path: data.path as string,
      subcolecao: (data.subcolecao as string | null | undefined) ?? null,
      docId: data.docId as string,
      kind: data.kind as Kind,
      campos: (data.campos as string[] | undefined) ?? [],
      timestamp: typeof data.timestamp === 'number' ? data.timestamp : null,
    };
  });
}

async function fetchListViaClassicQuery(
  db: Firestore,
  produtoId: string,
  after: DocumentSnapshot | null,
): Promise<{ rows: ListEntry[]; lastSnap: DocumentSnapshot | null }> {
  // `paginate`'s `startAfter(snapshot)` cursor is exact (tiebroken by doc id),
  // so same-millisecond entries are never skipped — unlike the pipeline
  // path's `timestamp <` filter (see its doc comment).
  const snap = await getDocs(
    buildQuery(historicoModificacoesCollection.ref(db, { produtoId }), [
      orderByField('timestamp', 'desc'),
      ...paginate({ after: after ?? undefined, pageSize: PAGE_SIZE }),
    ]),
  );
  const rows = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      path: data.path,
      subcolecao: data.subcolecao ?? null,
      docId: data.docId,
      kind: data.kind,
      campos: data.campos,
      timestamp: data.timestamp,
    };
  });
  return { rows, lastSnap: snap.docs[snap.docs.length - 1] ?? null };
}

/**
 * Try the Pipeline path first (cuts the payload via `.select()`), falling
 * back to a classic query when the SDK predates Pipelines
 * (`PipelineUnsupportedError`) OR the connected backend is the Firestore
 * Emulator (`USING_FIRESTORE_EMULATOR` — see the constant's doc comment).
 * Anything else thrown by the pipeline attempt is a real error and
 * propagates, matching `ProdutoHistoryButton`'s established fallback shape.
 */
async function fetchList(
  db: Firestore,
  produtoId: string,
  cursor: { beforeTs: number | null; afterSnap: DocumentSnapshot | null },
): Promise<{ rows: ListEntry[]; lastSnap: DocumentSnapshot | null }> {
  if (isPipelineSupported(db) && !USING_FIRESTORE_EMULATOR) {
    try {
      const rows = await fetchListViaPipeline(db, produtoId, cursor.beforeTs);
      return { rows, lastSnap: null };
    } catch (err) {
      if (!(err instanceof PipelineUnsupportedError)) throw err;
      // Fall through to the classic query below.
    }
  }
  return fetchListViaClassicQuery(db, produtoId, cursor.afterSnap);
}

export interface ModificacoesManagerProps {
  db: Firestore;
  produtoId: string;
}

/**
 * "Modificações" tab — a read-only, newest-first feed of the produto's
 * unified `historicoDeModificacoes` entries, with per-field revert
 * ("Restaurar") for a whitelist of safe fields (`@/lib/produtos/revert`).
 * `create`/`delete` entries are display-only (no Restaurar) — v1 only
 * reverts a field-level `update` change.
 *
 * The list itself stays light (no `changes` map) and pages newest-first —
 * exactly (snapshot cursor) on the classic path, by `timestamp <` on the
 * pipeline path (Pipelines have no `startAfter`); expanding a row lazy-loads
 * that ONE entry's full doc (a single doc get, not a query) to reveal its
 * per-field old → new values.
 */
export function ModificacoesManager({ db, produtoId }: ModificacoesManagerProps) {
  const [entries, setEntries] = useState<ListEntry[]>([]);
  // Classic-path page cursor (null while on the pipeline path, which cursors
  // by timestamp instead). A ref, not state: it never drives a render.
  const lastSnapRef = useRef<DocumentSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fullById, setFullById] = useState<Record<string, FullEntryState>>({});
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setListError(null);
    fetchList(db, produtoId, { beforeTs: null, afterSnap: null })
      .then(({ rows, lastSnap }) => {
        if (cancelled) return;
        lastSnapRef.current = lastSnap;
        setEntries(rows);
        setHasMore(rows.length === PAGE_SIZE);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof FirebaseError) {
          setListError(`Falha ao carregar o histórico: ${err.code}`);
          setLoading(false);
          return;
        }
        throw err;
      });
    return () => {
      cancelled = true;
    };
  }, [db, produtoId, refreshKey]);

  async function handleLoadMore() {
    const last = entries[entries.length - 1];
    if (!last || last.timestamp === null) return;
    setLoadingMore(true);
    try {
      const { rows, lastSnap } = await fetchList(db, produtoId, {
        beforeTs: last.timestamp,
        afterSnap: lastSnapRef.current,
      });
      if (lastSnap) lastSnapRef.current = lastSnap;
      setEntries((prev) => [...prev, ...rows]);
      setHasMore(rows.length === PAGE_SIZE);
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({
          color: 'red',
          message: `Falha ao carregar mais modificações: ${err.code}`,
        });
        return;
      }
      throw err;
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleToggleExpand(entry: ListEntry) {
    if (expandedId === entry.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(entry.id);
    const existing = fullById[entry.id];
    if (existing && existing.status !== 'error') return;
    setFullById((prev) => ({ ...prev, [entry.id]: { status: 'loading' } }));
    try {
      const docSnap = await getDoc(
        historicoModificacoesCollection.docRef(db, { produtoId }, entry.id),
      );
      const data = docSnap.data();
      setFullById((prev) => ({
        ...prev,
        [entry.id]: { ...entry, status: 'ready', changes: data?.changes ?? {} },
      }));
    } catch (err) {
      if (err instanceof FirebaseError) {
        setFullById((prev) => ({
          ...prev,
          [entry.id]: { status: 'error', message: `Falha ao carregar detalhes: ${err.code}` },
        }));
        return;
      }
      throw err;
    }
  }

  async function handleRestaurar(
    entry: ListEntry,
    field: string,
    change: { old: unknown; new: unknown },
  ) {
    const target: RevertTarget = {
      produtoId,
      subcolecao: entry.subcolecao,
      docId: entry.docId,
      field,
      oldValue: change.old,
      newValue: change.new,
    };
    const key = `${entry.id}:${field}`;
    setPendingKey(key);
    try {
      const { conflict: hasConflict, currentValue } = await checkRevert(db, target);
      if (hasConflict) {
        setConflict({ entryId: entry.id, field, target, currentValue });
        return;
      }
      await finishRestaurar(entry.id, target);
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({
          color: 'red',
          title: 'Falha ao restaurar',
          message: err.message,
        });
        return;
      }
      // `merge()` re-validates the patch (`parseMergePatch`); an old value
      // that no longer fits the CURRENT schema (schema evolution, or a legacy
      // Flutter-written field outside it) surfaces here instead of silently
      // rejecting the write.
      if (err instanceof ZodError) {
        notifications.show({
          color: 'red',
          title: 'Falha ao restaurar',
          message: 'Não foi possível restaurar: o valor antigo é incompatível com o esquema atual.',
        });
        return;
      }
      throw err;
    } finally {
      setPendingKey(null);
    }
  }

  async function finishRestaurar(entryId: string, target: RevertTarget) {
    await applyRevert(db, target);
    notifications.show({ color: 'teal', message: `Campo "${target.field}" restaurado.` });
    // A new entry now exists server-side — the next list refresh will surface
    // it. Collapse this row (not just drop its cached detail): its cached
    // `changes` are now stale, and nothing besides a fresh `onToggle` click
    // re-fetches them, so leaving it expanded would strand the user on a
    // spinner that never resolves.
    setRefreshKey((k) => k + 1);
    setExpandedId((id) => (id === entryId ? null : id));
    setFullById((prev) => {
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
  }

  async function handleConfirmConflict() {
    if (!conflict) return;
    setConfirming(true);
    try {
      await finishRestaurar(conflict.entryId, conflict.target);
      setConflict(null);
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({
          color: 'red',
          title: 'Falha ao restaurar',
          message: err.message,
        });
        return;
      }
      // Same schema-evolution surface as `handleRestaurar`'s catch.
      if (err instanceof ZodError) {
        notifications.show({
          color: 'red',
          title: 'Falha ao restaurar',
          message: 'Não foi possível restaurar: o valor antigo é incompatível com o esquema atual.',
        });
        return;
      }
      throw err;
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Stack gap="md">
      {listError && <Alert color="red">{listError}</Alert>}
      {!listError && loading && <Loader size="sm" />}
      {!listError && !loading && entries.length === 0 && (
        <Text size="sm" c="dimmed">
          Nenhuma modificação registrada.
        </Text>
      )}
      {entries.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          expanded={expandedId === entry.id}
          full={fullById[entry.id]}
          pendingKey={pendingKey}
          onToggle={() => void handleToggleExpand(entry)}
          onRestaurar={(field, change) => void handleRestaurar(entry, field, change)}
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
      <Modal
        opened={conflict !== null}
        onClose={() => setConflict(null)}
        title="Valor mudou desde a modificação"
        centered
      >
        {conflict && (
          <Stack gap="xs">
            <Text size="sm">
              O campo <strong>{conflict.field}</strong> foi alterado novamente desde este registro.
            </Text>
            <Text size="sm">
              Valor que esta ação restauraria: {renderValue(conflict.target.oldValue)}
            </Text>
            <Text size="sm">Valor atual: {renderValue(conflict.currentValue)}</Text>
            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={() => setConflict(null)} disabled={confirming}>
                Cancelar
              </Button>
              <Button color="red" onClick={() => void handleConfirmConflict()} loading={confirming}>
                Restaurar mesmo assim
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

interface EntryRowProps {
  entry: ListEntry;
  expanded: boolean;
  full: FullEntryState | undefined;
  pendingKey: string | null;
  onToggle: () => void;
  onRestaurar: (field: string, change: { old: unknown; new: unknown }) => void;
}

function EntryRow({ entry, expanded, full, pendingKey, onToggle, onRestaurar }: EntryRowProps) {
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
          <Text size="sm">
            {entry.subcolecao ? `${entry.subcolecao} · ${entry.docId}` : entry.docId}
          </Text>
          {entry.campos.length > 0 && (
            <Text size="xs" c="dimmed">
              Campos: {entry.campos.join(', ')}
            </Text>
          )}
        </Group>
        <ActionIcon variant="subtle" onClick={onToggle} aria-label="Detalhes da modificação">
          {expanded ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
        </ActionIcon>
      </Group>
      {expanded && (
        <Box mt="xs" ml="md">
          {(!full || full.status === 'loading') && <Loader size="xs" />}
          {full && full.status === 'error' && <Alert color="red">{full.message}</Alert>}
          {full && full.status === 'ready' && (
            <Stack gap="xs">
              {Object.entries(full.changes).map(([field, change]) => (
                <FieldChangeRow
                  key={field}
                  entry={entry}
                  field={field}
                  change={change}
                  pending={pendingKey === `${entry.id}:${field}`}
                  onRestaurar={onRestaurar}
                />
              ))}
              {Object.keys(full.changes).length === 0 && (
                <Text size="xs" c="dimmed">
                  Sem detalhes de campos para esta entrada.
                </Text>
              )}
            </Stack>
          )}
        </Box>
      )}
    </Box>
  );
}

interface FieldChangeRowProps {
  entry: ListEntry;
  field: string;
  change: { old: unknown; new: unknown };
  pending: boolean;
  onRestaurar: (field: string, change: { old: unknown; new: unknown }) => void;
}

function FieldChangeRow({ entry, field, change, pending, onRestaurar }: FieldChangeRowProps) {
  const canOfferRestaurar = entry.kind === 'update';
  const gate = canOfferRestaurar ? isRevertible(entry.subcolecao, field, change) : null;
  const isPrecosOnParent = entry.subcolecao === null && field === 'precos';

  return (
    <Group gap="xs" wrap="wrap" align="center">
      <Text size="sm" fw={500} style={{ minWidth: 140 }}>
        {field}
      </Text>
      <Text size="sm">
        {renderValue(change.old)} → {renderValue(change.new)}
      </Text>
      {canOfferRestaurar && gate?.ok && (
        <>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconArrowBackUp size={14} />}
            loading={pending}
            onClick={() => onRestaurar(field, change)}
            aria-label={`Restaurar ${field}`}
          >
            Restaurar
          </Button>
          {isPrecosOnParent && (
            <Text size="xs" c="orange">
              Restaurar o preço gera uma nova entrada de histórico e propaga para as variações.
            </Text>
          )}
        </>
      )}
      {canOfferRestaurar && gate && !gate.ok && (
        <Tooltip label={gate.reason ?? undefined}>
          <Button
            size="xs"
            variant="light"
            color="gray"
            disabled
            leftSection={<IconArrowBackUp size={14} />}
            aria-label={`Restaurar ${field}`}
            title={gate.reason ?? undefined}
          >
            Restaurar
          </Button>
        </Tooltip>
      )}
    </Group>
  );
}
