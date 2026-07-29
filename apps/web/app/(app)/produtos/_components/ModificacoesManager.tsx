'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { type Firestore, getDocs } from 'firebase/firestore';
import { ZodError } from 'zod';
import { buildQuery, limit, orderByField, paginate } from '@delfrance/data';
import { useSnapshotWithDocs, type SnapshotRow } from '@delfrance/data/hooks';
import { TRUNCATED_VALUE_KEY } from '@delfrance/core';
import { microsToDate } from '@delfrance/core/datetime';
import type { HistoricoModificacao } from '@delfrance/schemas';
import { historicoModificacoesCollection } from '@/lib/data/historicoModificacoesCollection';
import { applyRevert, checkRevert, isRevertible, type RevertTarget } from '@/lib/produtos/revert';

/** Newest-first page size for both the live window and "Carregar mais". */
const PAGE_SIZE = 50;

type Kind = 'create' | 'update' | 'delete';

/**
 * One row of the list. Classic `onSnapshot` / `getDocs` already carry the full
 * doc (incl. `changes`), so expand reuses that map instead of a second `getDoc`.
 */
interface ListEntry {
  id: string;
  path: string;
  subcolecao: string | null;
  docId: string;
  kind: Kind;
  campos: string[];
  timestamp: number | null;
  changes: Record<string, { old: unknown; new: unknown }>;
  /** Present on live + load-more rows that still hold a cursor for pagination. */
  snap?: SnapshotRow<HistoricoModificacao>['snap'];
}

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
    snap: row.snap,
  };
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
 * Page 1 is a classic realtime query (`useSnapshotWithDocs` / `onSnapshot`)
 * so a save + "Salvar e continuar" surfaces the trigger-written entry without
 * a manual reload or poll (issue #661). Deeper pages stay one-shot `getDocs`
 * via snapshot cursors (same live+tail shape as the chat inbox). Expanding a
 * row shows the `changes` map already on the streamed doc — no second get.
 */
export function ModificacoesManager({ db, produtoId }: ModificacoesManagerProps) {
  const liveQuery = useMemo(
    () =>
      buildQuery(historicoModificacoesCollection.ref(db, { produtoId }), [
        orderByField('timestamp', 'desc'),
        limit(PAGE_SIZE),
      ]),
    [db, produtoId],
  );

  const live = useSnapshotWithDocs<HistoricoModificacao>(liveQuery);

  const [extraRows, setExtraRows] = useState<SnapshotRow<HistoricoModificacao>[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Drop the one-shot tail when the product (or db) identity changes so a
  // previous product's paged history never bleeds into the next. Setting state
  // in an effect is the sanctioned reset shape here (same as `useConversaQuery`):
  // an in-render "derive from key" swap can't cancel in-flight loadMore results.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on identity change
    setExtraRows([]);
    setExhausted(false);
    setLoadingMore(false);
    setExpandedId(null);
  }, [db, produtoId]);

  // Live page first (authoritative + fresh), then the one-shot tail with any
  // id already surfaced live dropped — same merge as `useConversaQuery`.
  const entries = useMemo(() => {
    const liveRows = (live.data ?? []).map(rowToEntry);
    const seen = new Set(liveRows.map((r) => r.id));
    const tail = extraRows.filter((r) => !seen.has(r.id)).map(rowToEntry);
    return [...liveRows, ...tail];
  }, [live.data, extraRows]);

  const hasMore = !exhausted && entries.length >= PAGE_SIZE;
  const loading = live.loading;
  const listError = live.error ? `Falha ao carregar o histórico: ${live.error.code}` : null;

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || exhausted) return;
    const cursor = entries[entries.length - 1]?.snap;
    if (!cursor) return;

    setLoadingMore(true);
    try {
      const pageQuery = buildQuery(historicoModificacoesCollection.ref(db, { produtoId }), [
        orderByField('timestamp', 'desc'),
        ...paginate({ after: cursor, pageSize: PAGE_SIZE }),
      ]);
      const snap = await getDocs(pageQuery);
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
      if (newRows.length < PAGE_SIZE) setExhausted(true);
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
  }, [loadingMore, exhausted, entries, db, produtoId]);

  function handleToggleExpand(entry: ListEntry) {
    setExpandedId((id) => (id === entry.id ? null : entry.id));
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
    // A new history entry is written server-side by the trigger — the live
    // `onSnapshot` surfaces it; no manual refresh. Collapse this row so the
    // user is not stranded on a stale expand of the pre-revert change set.
    setExpandedId((id) => (id === entryId ? null : id));
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
          pendingKey={pendingKey}
          onToggle={() => handleToggleExpand(entry)}
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
  pendingKey: string | null;
  onToggle: () => void;
  onRestaurar: (field: string, change: { old: unknown; new: unknown }) => void;
}

function EntryRow({ entry, expanded, pendingKey, onToggle, onRestaurar }: EntryRowProps) {
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
          <Stack gap="xs">
            {Object.entries(entry.changes).map(([field, change]) => (
              <FieldChangeRow
                key={field}
                entry={entry}
                field={field}
                change={change}
                pending={pendingKey === `${entry.id}:${field}`}
                onRestaurar={onRestaurar}
              />
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
