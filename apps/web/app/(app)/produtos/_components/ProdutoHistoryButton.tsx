'use client';

import { useState } from 'react';
import { ActionIcon, Alert, Loader, Modal, Table, Text, Tooltip } from '@mantine/core';
import { IconHistory } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { type Firestore, getDocs } from 'firebase/firestore';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { formatReais } from '@delfrance/core';
import {
  historicoCustoCollection,
  historicoPrecoCollection,
} from '@/lib/data/historicoCollections';

const brl = (value: number) => formatReais(value);
const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

interface HistoryRow {
  key: string;
  when: string;
  texto: string;
}

interface HistoryState {
  open: boolean;
  loading: boolean;
  rows: HistoryRow[];
  error: string | null;
}

export interface ProdutoHistoryButtonProps {
  kind: 'preco' | 'custo';
  db: Firestore;
  produtoId: string;
  /** Price history: only rows of this lista show (matched by outerRef last segment). */
  listaId?: string;
  /** Human label for the modal title / accessible name (the lista name, or "Custo"). */
  label: string;
}

/**
 * Read-only history viewer for a produto's `historicoDePrecos` (per lista) or
 * `historicoDeCusto`. Queries ordered by `timestamp` desc (the 100-doc cap
 * keeps the newest); price rows are filtered client-side to the given lista.
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
      if (kind === 'preco') {
        const snap = await getDocs(
          buildQuery(historicoPrecoCollection.ref(db, { produtoId }), [
            orderByField('timestamp', 'desc'),
            limit(100),
          ]),
        );
        const rows = snap.docs
          .map((d) => ({ id: d.id, data: d.data() }))
          // outerRef is `documents/listaDePrecos/<id>` (legacy may omit the
          // prefix) — match by last path segment.
          .filter((r) => r.data.listaDePrecoHistoricoOuterRef.split('/').pop() === listaId)
          .map((r) => ({
            key: r.id,
            when: r.data.timestamp ? dateFmt.format(new Date(r.data.timestamp)) : '—',
            texto: `${r.data.valorOriginal != null ? brl(r.data.valorOriginal) : '—'} → ${
              r.data.valorFinal != null ? brl(r.data.valorFinal) : 'removido'
            }`,
          }));
        setState({ open: true, loading: false, rows, error: null });
      } else {
        const snap = await getDocs(
          buildQuery(historicoCustoCollection.ref(db, { produtoId }), [
            orderByField('timestamp', 'desc'),
            limit(100),
          ]),
        );
        const rows = snap.docs.map((d) => {
          const data = d.data();
          return {
            key: d.id,
            when: data.timestamp ? dateFmt.format(new Date(data.timestamp)) : '—',
            texto: brl(data.valor),
          };
        });
        setState({ open: true, loading: false, rows, error: null });
      }
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
                  <Table.Td>{row.when}</Table.Td>
                  <Table.Td>{row.texto}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Modal>
    </>
  );
}
