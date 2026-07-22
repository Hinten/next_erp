'use client';

import { useState } from 'react';
import { ActionIcon, Alert, Loader, Modal, Table, Text, Tooltip } from '@mantine/core';
import { IconHistory } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { type Firestore, getDocs } from 'firebase/firestore';
import { execute } from 'firebase/firestore/pipelines';
import {
  PIPELINE_ID_FIELD,
  PipelineUnsupportedError,
  buildPipeline,
  buildQuery,
  isPipelineSupported,
  limit,
  orderByField,
  whereArrayContains,
} from '@delfrance/data';
import { formatReais } from '@delfrance/core';
import { historicoModificacoesCollection } from '@/lib/data/historicoModificacoesCollection';
import {
  buildCustoHistoryRows,
  buildPrecoHistoryRows,
  type HistoryDisplayRow,
  type HistoryEntryRow,
  type HistoryValue,
} from './historyRows';

const brl = (value: number) => formatReais(value);
const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/** `historicoDeModificacoes.campos` entry each kind's changes live under. */
const CHANGED_FIELD = { preco: 'precos', custo: 'custo' } as const;

interface HistoryState {
  open: boolean;
  loading: boolean;
  rows: HistoryDisplayRow[];
  error: string | null;
}

export interface ProdutoHistoryButtonProps {
  kind: 'preco' | 'custo';
  db: Firestore;
  produtoId: string;
  /** Price history: only rows touching this lista show. */
  listaId?: string;
  /** Human label for the modal title / accessible name (the lista name, or "Custo"). */
  label: string;
}

/**
 * Read-only history viewer for a produto's price/cost changes, sourced from
 * the unified `historicoDeModificacoes` collection (one doc per Firestore
 * trigger CloudEvent — see `@delfrance/schemas`' `historicoModificacaoSchema`).
 * Reads through a projecting Pipeline query when the SDK supports it — the
 * `select` stage cuts the payload down to just the relevant `changes.<field>`
 * side plus `timestamp`, so a document with a large `changes` map never
 * crosses the wire in full — and falls back to a classic query otherwise
 * (older SDK, or a thrown `PipelineUnsupportedError`). Ordered by
 * `timestamp` desc (100-doc cap keeps the newest); price rows are further
 * filtered, per lista, in `historyRows.ts`.
 */
export function ProdutoHistoryButton({
  kind,
  db,
  produtoId,
  listaId,
  label,
}: ProdutoHistoryButtonProps) {
  const [state, setState] = useState<HistoryState>({
    open: false,
    loading: false,
    rows: [],
    error: null,
  });

  async function open() {
    setState({ open: true, loading: true, rows: [], error: null });
    try {
      const entries = await fetchHistoryEntries(db, produtoId, CHANGED_FIELD[kind]);
      const rows =
        kind === 'preco'
          ? buildPrecoHistoryRows(entries, listaId ?? '')
          : buildCustoHistoryRows(entries);
      setState({ open: true, loading: false, rows, error: null });
    } catch (err) {
      if (err instanceof FirebaseError) {
        setState({
          open: true,
          loading: false,
          rows: [],
          error: `Falha ao carregar o histórico: ${err.code}`,
        });
        return;
      }
      throw err;
    }
  }

  const title = kind === 'preco' ? `Histórico de preço — ${label}` : 'Histórico de custo';
  const ariaLabel = kind === 'preco' ? `Histórico de ${label}` : 'Histórico de custo';

  return (
    <>
      <Tooltip label={title}>
        <ActionIcon variant="subtle" mb={4} onClick={() => void open()} aria-label={ariaLabel}>
          <IconHistory size={16} />
        </ActionIcon>
      </Tooltip>
      <Modal
        opened={state.open}
        onClose={() => setState((s) => ({ ...s, open: false }))}
        title={title}
        size="md"
      >
        {state.loading && <Loader size="sm" />}
        {state.error && <Alert color="red">{state.error}</Alert>}
        {!state.loading && !state.error && state.rows.length === 0 && (
          <Text size="sm" c="dimmed">
            Nenhum registro.
          </Text>
        )}
        {state.rows.length > 0 && (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Data</Table.Th>
                <Table.Th>Valor</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {state.rows.map((row) => (
                <Table.Tr key={row.key}>
                  <Table.Td>
                    {row.timestamp ? dateFmt.format(new Date(row.timestamp)) : '—'}
                  </Table.Td>
                  <Table.Td>
                    <ValorLado value={row.original} vazio="—" />
                    {' → '}
                    <ValorLado value={row.final} vazio="removido" />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Modal>
    </>
  );
}

/**
 * One side (old/new) of a history row's value: a BRL amount, `vazio` when
 * absent (added/removed), or a tooltipped em-dash when `HistoryValue.truncated`
 * — the value was too large for the trigger to store verbatim.
 */
function ValorLado({ value, vazio }: { value: HistoryValue; vazio: string }) {
  if (value.truncated) {
    return (
      <Tooltip label="Valor grande demais para exibir">
        <Text component="span" c="dimmed">
          —
        </Text>
      </Tooltip>
    );
  }
  return <>{value.value != null ? brl(value.value) : vazio}</>;
}

async function fetchHistoryEntries(
  db: Firestore,
  produtoId: string,
  changedField: string,
): Promise<HistoryEntryRow[]> {
  if (isPipelineSupported(db)) {
    try {
      return await fetchHistoryEntriesViaPipeline(db, produtoId, changedField);
    } catch (err) {
      if (!(err instanceof PipelineUnsupportedError)) throw err;
      // Fall through to the classic query below.
    }
  }
  return fetchHistoryEntriesViaClassicQuery(db, produtoId, changedField);
}

async function fetchHistoryEntriesViaPipeline(
  db: Firestore,
  produtoId: string,
  changedField: string,
): Promise<HistoryEntryRow[]> {
  const pipeline = buildPipeline(db, {
    collection: historicoModificacoesCollection.resolvePath({ produtoId }),
    filters: [{ field: 'campos', op: 'array-contains', value: changedField }],
    orderBy: [{ field: 'timestamp', direction: 'desc' }],
    select: [{ field: `changes.${changedField}`, as: 'change' }, 'timestamp'],
    limit: 100,
  });
  const snap = await execute(pipeline);
  return snap.results.map((r) => {
    const data = r.data() as Record<string, unknown>;
    // `.select()` strips `PipelineResult.ref`; the id survives as the
    // PIPELINE_ID_FIELD projection `buildPipeline` appends — read it back
    // and strip it (mirrors `usePipelineSnapshot`'s row-reading pattern).
    const projectedId =
      typeof data[PIPELINE_ID_FIELD] === 'string' ? (data[PIPELINE_ID_FIELD] as string) : undefined;
    if (PIPELINE_ID_FIELD in data) delete data[PIPELINE_ID_FIELD];
    return {
      id: r.ref?.id ?? r.id ?? projectedId ?? '',
      change: data.change as { old: unknown; new: unknown } | undefined,
      timestamp: typeof data.timestamp === 'number' ? data.timestamp : null,
    };
  });
}

async function fetchHistoryEntriesViaClassicQuery(
  db: Firestore,
  produtoId: string,
  changedField: string,
): Promise<HistoryEntryRow[]> {
  const snap = await getDocs(
    buildQuery(historicoModificacoesCollection.ref(db, { produtoId }), [
      whereArrayContains('campos', changedField),
      orderByField('timestamp', 'desc'),
      limit(100),
    ]),
  );
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      change: data.changes[changedField],
      timestamp: data.timestamp,
    };
  });
}
