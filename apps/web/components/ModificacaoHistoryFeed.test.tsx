import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';
import type { HistoricoModificacao } from '@delfrance/schemas';

const h = vi.hoisted(() => ({
  getDocs: vi.fn(),
  snapState: {
    current: { data: undefined, loading: false, error: undefined } as SnapshotState<
      SnapshotRow<HistoricoModificacao>[]
    >,
  },
}));

vi.mock('@delfrance/data', () => ({
  buildQuery: (base: unknown, constraints: unknown[]) => ({ base, constraints }),
  orderByField: vi.fn(),
  limit: vi.fn(),
  paginate: vi.fn(() => []),
}));
vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return { ...actual, useSnapshotWithDocs: () => h.snapState.current };
});
vi.mock('firebase/firestore', () => ({ getDocs: h.getDocs }));
vi.mock('./UsuarioNome', () => ({
  UsuarioNome: () => null,
  useUsuarioNomes: () => ({}),
  uidFromUsuarioRef: () => null,
}));

import { ModificacaoHistoryFeed, type ListEntry } from './ModificacaoHistoryFeed';

const db = {} as unknown as Firestore;
const collection = {
  ref: () => ({ __marker: 'ref' }),
} as never;

/** An own row: carries a snapshot cursor, so it can anchor pagination. */
function ownRow(id: string, timestamp: number): SnapshotRow<HistoricoModificacao> {
  return {
    id,
    path: `pedidos/ped1/historicoDeModificacoes/${id}`,
    data: {
      path: 'pedidos/ped1',
      subcolecao: null,
      docId: 'ped1',
      kind: 'update',
      campos: ['estado'],
      changes: { estado: { old: 'a', new: 'b' } },
      timestamp,
      eventId: id,
    } as unknown as HistoricoModificacao,
    snap: { id, __cursor: true } as never,
  };
}

/** An injected row: NO snapshot, and always older than the own rows. */
function extra(
  id: string,
  timestamp: number,
  supersededByEntryId: string | null = null,
): ListEntry {
  return {
    id,
    path: 'pedidos/ped1',
    subcolecao: null,
    docId: 'ped1',
    kind: 'update',
    campos: ['estado'],
    timestamp,
    changes: { estado: { old: null, new: 'Pago' } },
    usuarioOuterRef: null,
    supersededByEntryId,
  };
}

function renderFeed(props: { extraEntries?: ListEntry[]; pageSize?: number } = {}) {
  return render(
    <MantineProvider env="test">
      <ModificacaoHistoryFeed
        db={db}
        collection={collection}
        ctx={{ pedidoId: 'ped1' }}
        pageSize={props.pageSize ?? 2}
        extraEntries={props.extraEntries}
      />
    </MantineProvider>,
  );
}

beforeEach(() => {
  h.getDocs.mockReset();
  h.getDocs.mockResolvedValue({ docs: [] });
});

describe('ModificacaoHistoryFeed — pagination is driven by OWN rows only', () => {
  it('still paginates when older cursor-less rows are interleaved', async () => {
    // Regression: `extraEntries` carry no snapshot and are by construction the
    // OLDEST rows, so they always sort last. Taking the cursor from the merged
    // list picked a cursor-less row and `handleLoadMore` returned silently —
    // "Carregar mais" did nothing at all on any pedido with legacy history.
    h.snapState.current = {
      data: [ownRow('e1', 300), ownRow('e2', 200)],
      loading: false,
      error: undefined,
    };
    renderFeed({ extraEntries: [extra('legado-1', 100)] });

    const botao = screen.getByRole('button', { name: 'Carregar mais' });
    fireEvent.click(botao);

    await waitFor(() => expect(h.getDocs).toHaveBeenCalledTimes(1));
  });

  it('hides the button when only the injected rows pad the list to pageSize', () => {
    // `hasMore` counted the injected rows too, so a pedido with 1 real entry and
    // 50 legacy ones offered a button that could never do anything.
    h.snapState.current = { data: [ownRow('e1', 300)], loading: false, error: undefined };
    renderFeed({ extraEntries: [extra('legado-1', 200), extra('legado-2', 100)] });

    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
  });

  it('renders the injected rows even though they cannot be paginated', () => {
    h.snapState.current = { data: [ownRow('e1', 300)], loading: false, error: undefined };
    renderFeed({ extraEntries: [extra('legado-1', 100)] });

    expect(screen.getAllByTestId('modificacao-entry')).toHaveLength(2);
  });
});

describe('ModificacaoHistoryFeed — superseded injected rows', () => {
  it('hides an injected row when the entry it duplicates is loaded', () => {
    h.snapState.current = { data: [ownRow('evt-1', 300)], loading: false, error: undefined };
    renderFeed({ extraEntries: [extra('legado-1', 290, 'evt-1')] });

    expect(screen.getAllByTestId('modificacao-entry')).toHaveLength(1);
  });

  it('KEEPS it when the replacement is not there — the pre-deploy window', () => {
    // A transition recorded by the already-deployed estado trigger carries an
    // eventId but has no history row yet. Filtering on "has an eventId" would
    // drop it from the tab forever; keying on what is actually loaded does not.
    h.snapState.current = { data: [ownRow('evt-9', 300)], loading: false, error: undefined };
    renderFeed({ extraEntries: [extra('legado-1', 290, 'evt-1')] });

    expect(screen.getAllByTestId('modificacao-entry')).toHaveLength(2);
  });
});
