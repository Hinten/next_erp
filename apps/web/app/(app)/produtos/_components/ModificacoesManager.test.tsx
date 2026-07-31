import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { Firestore, FirestoreError } from 'firebase/firestore';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';
import type { HistoricoModificacao } from '@delfrance/schemas';

// Hoisted mocks (vi.mock factories can't close over normal consts).
const h = vi.hoisted(() => ({
  getDocs: vi.fn(),
  applyRevert: vi.fn(),
  checkRevert: vi.fn(),
  isRevertible: vi.fn(() => ({ ok: true, reason: null }) as { ok: boolean; reason: string | null }),
  snapState: {
    current: {
      data: undefined,
      loading: true,
      error: undefined,
    } as SnapshotState<SnapshotRow<HistoricoModificacao>[]>,
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
vi.mock('@/lib/data/historicoModificacoesCollection', () => ({
  historicoModificacoesCollection: {
    resolvePath: () => 'produtos/p1/historicoDeModificacoes',
    ref: () => ({ __marker: 'ref' }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ __marker: 'docRef', id }),
  },
}));
vi.mock('@/lib/produtos/revert', () => ({
  applyRevert: h.applyRevert,
  checkRevert: h.checkRevert,
  isRevertible: h.isRevertible,
}));

import { ModificacoesManager } from './ModificacoesManager';

const db = {} as unknown as Firestore;

interface RawEntry {
  id: string;
  path: string;
  subcolecao: string | null;
  docId: string;
  kind: 'create' | 'update' | 'delete';
  campos: string[];
  timestamp: number;
  changes: Record<string, { old: unknown; new: unknown }>;
}

function toRow(e: RawEntry): SnapshotRow<HistoricoModificacao> {
  return {
    id: e.id,
    path: `produtos/p1/historicoDeModificacoes/${e.id}`,
    data: {
      path: e.path,
      subcolecao: e.subcolecao,
      docId: e.docId,
      kind: e.kind,
      campos: e.campos,
      changes: e.changes,
      timestamp: e.timestamp,
      eventId: e.id,
    },
    // Cursor stub — only needed for load-more tests; identity is enough.
    snap: { id: e.id } as SnapshotRow<HistoricoModificacao>['snap'],
  };
}

function setSnap(state: Partial<SnapshotState<SnapshotRow<HistoricoModificacao>[]>>) {
  h.snapState.current = {
    data: undefined,
    loading: false,
    error: undefined,
    ...state,
  };
}

function renderManager(entries: RawEntry[] = [], loading = false) {
  setSnap({ data: entries.map(toRow), loading });
  return render(
    <MantineProvider>
      <ModificacoesManager db={db} produtoId="p1" />
    </MantineProvider>,
  );
}

async function expandRow(index: number) {
  const toggles = await screen.findAllByRole('button', { name: 'Detalhes da modificação' });
  fireEvent.click(toggles[index]!);
}

afterEach(() => {
  h.snapState.current = { data: undefined, loading: true, error: undefined };
  h.getDocs.mockReset();
  h.applyRevert.mockReset();
  h.checkRevert.mockReset();
  h.isRevertible.mockReset();
  h.isRevertible.mockReturnValue({ ok: true, reason: null });
});

// The two pagination tests seed a full live page (`PAGE_SIZE` = 50) so that
// "Carregar mais" appears, then re-render it twice more — ~150 Mantine rows
// through jsdom. That lands near 1s locally but can exceed Vitest's 5s default
// under CI load (many workspaces running tests concurrently on limited CPU).
// The budget is raised per-suite rather than globally so genuine hangs elsewhere
// still fail fast.
describe('ModificacoesManager', { timeout: 30_000 }, () => {
  it('shows the empty state when there is no history yet', async () => {
    renderManager([]);
    expect(await screen.findByText('Nenhuma modificação registrada.')).toBeTruthy();
  });

  it('surfaces a subscription error instead of the empty state', async () => {
    setSnap({
      error: {
        name: 'FirebaseError',
        code: 'permission-denied',
        message: 'Missing or insufficient permissions.',
      } as FirestoreError,
    });
    render(
      <MantineProvider>
        <ModificacoesManager db={db} produtoId="p1" />
      </MantineProvider>,
    );
    expect(await screen.findByText(/permission-denied/)).toBeTruthy();
  });

  it('renders entries with their kind badge', async () => {
    renderManager([
      {
        id: 'evt-create',
        path: 'produtos/p1',
        subcolecao: null,
        docId: 'p1',
        kind: 'create',
        campos: ['nome'],
        timestamp: 1,
        changes: { nome: { old: null, new: 'Produto A' } },
      },
      {
        id: 'evt-update',
        path: 'produtos/p1',
        subcolecao: null,
        docId: 'p1',
        kind: 'update',
        campos: ['nome'],
        timestamp: 2,
        changes: { nome: { old: 'Produto A', new: 'Produto B' } },
      },
      {
        id: 'evt-delete',
        path: 'produtos/p1/imposto/op1',
        subcolecao: 'imposto',
        docId: 'op1',
        kind: 'delete',
        campos: ['origem'],
        timestamp: 3,
        changes: { origem: { old: '0', new: null } },
      },
    ]);

    expect((await screen.findAllByTestId('modificacao-entry')).length).toBe(3);
    expect(screen.getByText('criação')).toBeTruthy();
    expect(screen.getByText('edição')).toBeTruthy();
    expect(screen.getByText('exclusão')).toBeTruthy();
  });

  it('picks up a new history entry when the live snapshot updates (#661)', async () => {
    const { rerender } = renderManager([
      {
        id: 'evt-1',
        path: 'produtos/p1',
        subcolecao: null,
        docId: 'p1',
        kind: 'update',
        campos: ['nome'],
        timestamp: 1,
        changes: { nome: { old: 'A', new: 'B' } },
      },
    ]);

    expect((await screen.findAllByTestId('modificacao-entry')).length).toBe(1);

    // Simulate the Cloud Function writing a new historicoDeModificacoes doc
    // after "Salvar e continuar" — onSnapshot pushes an updated page.
    act(() => {
      setSnap({
        data: [
          toRow({
            id: 'evt-2',
            path: 'produtos/p1',
            subcolecao: null,
            docId: 'p1',
            kind: 'update',
            campos: ['sku'],
            timestamp: 2,
            changes: { sku: { old: 'x', new: 'y' } },
          }),
          toRow({
            id: 'evt-1',
            path: 'produtos/p1',
            subcolecao: null,
            docId: 'p1',
            kind: 'update',
            campos: ['nome'],
            timestamp: 1,
            changes: { nome: { old: 'A', new: 'B' } },
          }),
        ],
      });
    });
    rerender(
      <MantineProvider>
        <ModificacoesManager db={db} produtoId="p1" />
      </MantineProvider>,
    );

    expect((await screen.findAllByTestId('modificacao-entry')).length).toBe(2);
    expect(screen.getByText(/Campos: sku/)).toBeTruthy();
  });

  it('never shows Restaurar on a create or delete row, even with revertible fields', async () => {
    renderManager([
      {
        id: 'evt-create',
        path: 'produtos/p1',
        subcolecao: null,
        docId: 'p1',
        kind: 'create',
        campos: ['nome'],
        timestamp: 1,
        changes: { nome: { old: null, new: 'Produto A' } },
      },
      {
        id: 'evt-delete',
        path: 'produtos/p1',
        subcolecao: null,
        docId: 'p1',
        kind: 'delete',
        campos: ['nome'],
        timestamp: 2,
        changes: { nome: { old: 'Produto A', new: null } },
      },
    ]);

    const rows = await screen.findAllByTestId('modificacao-entry');
    expect(rows.length).toBe(2);

    await expandRow(0);
    await expandRow(1);

    // isRevertible is never even consulted for display-only rows.
    expect(h.isRevertible).not.toHaveBeenCalled();
    for (const row of rows) {
      expect(within(row).queryByRole('button', { name: /^Restaurar/ })).toBeNull();
    }
  });

  it('shows a disabled Restaurar with a reason when the field is not revertible', async () => {
    h.isRevertible.mockReturnValue({
      ok: false,
      reason: 'Valor muito grande para restaurar automaticamente.',
    });

    renderManager([
      {
        id: 'evt-update',
        path: 'produtos/p1',
        subcolecao: null,
        docId: 'p1',
        kind: 'update',
        campos: ['precos'],
        timestamp: 1,
        changes: { precos: { old: { _truncated: true, _bytes: 999 }, new: { l1: { valor: 10 } } } },
      },
    ]);

    await expandRow(0);

    const button = (await screen.findByRole('button', {
      name: 'Restaurar precos',
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Valor muito grande para restaurar automaticamente.');
  });

  it('shows an enabled Restaurar for a whitelisted update field (changes come from the stream)', async () => {
    h.isRevertible.mockReturnValue({ ok: true, reason: null });

    renderManager([
      {
        id: 'evt-update',
        path: 'produtos/p1',
        subcolecao: null,
        docId: 'p1',
        kind: 'update',
        campos: ['nome'],
        timestamp: 1,
        changes: { nome: { old: 'Produto A', new: 'Produto B' } },
      },
    ]);

    await expandRow(0);

    // Expand uses the streamed `changes` map — no getDoc.
    const button = (await screen.findByRole('button', {
      name: 'Restaurar nome',
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.getByText(/Produto A → Produto B/)).toBeTruthy();
  });

  it('bridges a live-window eviction into the tail after Carregar mais (no pagination gap)', async () => {
    // Seed a full live page so "Carregar mais" appears, load an older tail row,
    // then slide the live window — the evicted middle doc must stay via bridge.
    h.getDocs.mockResolvedValue({
      docs: [
        {
          id: 'evt-0',
          ref: { path: 'produtos/p1/historicoDeModificacoes/evt-0' },
          data: () => ({
            path: 'produtos/p1',
            subcolecao: null,
            docId: 'p1',
            kind: 'update',
            campos: ['ncm'],
            changes: { ncm: { old: '1', new: '2' } },
            timestamp: 0,
            eventId: 'evt-0',
          }),
        },
      ],
    });

    const fullLive: RawEntry[] = Array.from({ length: 50 }, (_, i) => {
      const n = 100 - i;
      return {
        id: `evt-${n}`,
        path: 'produtos/p1',
        subcolecao: null,
        docId: 'p1',
        kind: 'update',
        campos: [`f${n}`],
        timestamp: n,
        changes: { [`f${n}`]: { old: 0, new: 1 } },
      };
    });

    const { rerender } = renderManager(fullLive);

    expect((await screen.findAllByTestId('modificacao-entry')).length).toBe(50);

    const loadMore = await screen.findByRole('button', { name: 'Carregar mais' });
    await act(async () => {
      fireEvent.click(loadMore);
    });

    // Tail has evt-0; live still full 50 → 51 total after dedupe.
    expect((await screen.findAllByTestId('modificacao-entry')).length).toBe(51);
    expect(screen.getByText(/Campos: ncm/)).toBeTruthy();

    // Slide live window: drop oldest live (fullLive[49] = evt-51); new evt-101 at front.
    const afterSlide: RawEntry[] = [
      {
        id: 'evt-101',
        path: 'produtos/p1',
        subcolecao: null,
        docId: 'p1',
        kind: 'update',
        campos: ['f101'],
        timestamp: 101,
        changes: { f101: { old: 0, new: 1 } },
      },
      ...fullLive.slice(0, 49),
    ];
    const evictedId = fullLive[49]!.id; // evt-51

    act(() => {
      setSnap({ data: afterSlide.map(toRow) });
    });
    rerender(
      <MantineProvider>
        <ModificacoesManager db={db} produtoId="p1" />
      </MantineProvider>,
    );

    // Bridge keeps the evicted live row + the load-more tail.
    const rows = await screen.findAllByTestId('modificacao-entry');
    expect(rows.length).toBe(52); // 50 live + bridge + evt-0
    expect(screen.getByText(/Campos: f101/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`Campos: f${evictedId.replace('evt-', '')}`))).toBeTruthy();
    expect(screen.getByText(/Campos: ncm/)).toBeTruthy();
  });

  it('ignores a load-more result that resolves after produtoId changes', async () => {
    let resolveDocs!: (value: {
      docs: Array<{
        id: string;
        ref: { path: string };
        data: () => Record<string, unknown>;
      }>;
    }) => void;
    h.getDocs.mockReturnValue(
      new Promise((resolve) => {
        resolveDocs = resolve;
      }),
    );

    const fullLive: RawEntry[] = Array.from({ length: 50 }, (_, i) => {
      const n = 100 - i;
      return {
        id: `evt-${n}`,
        path: 'produtos/p1',
        subcolecao: null,
        docId: 'p1',
        kind: 'update',
        campos: [`f${n}`],
        timestamp: n,
        changes: { [`f${n}`]: { old: 0, new: 1 } },
      };
    });

    const { rerender } = renderManager(fullLive);
    expect((await screen.findAllByTestId('modificacao-entry')).length).toBe(50);

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }));
    });

    // Switch product while the first load-more is still in flight.
    act(() => {
      setSnap({
        data: [
          toRow({
            id: 'other-1',
            path: 'produtos/p2',
            subcolecao: null,
            docId: 'p2',
            kind: 'update',
            campos: ['nome'],
            timestamp: 1,
            changes: { nome: { old: 'x', new: 'y' } },
          }),
        ],
      });
    });
    rerender(
      <MantineProvider>
        <ModificacoesManager db={db} produtoId="p2" />
      </MantineProvider>,
    );

    expect((await screen.findAllByTestId('modificacao-entry')).length).toBe(1);
    expect(screen.getByText(/Campos: nome/)).toBeTruthy();

    // Stale page for p1 must not append onto p2.
    await act(async () => {
      resolveDocs({
        docs: [
          {
            id: 'stale-from-p1',
            ref: { path: 'produtos/p1/historicoDeModificacoes/stale-from-p1' },
            data: () => ({
              path: 'produtos/p1',
              subcolecao: null,
              docId: 'p1',
              kind: 'update',
              campos: ['stale'],
              changes: { stale: { old: 0, new: 1 } },
              timestamp: 0,
              eventId: 'stale-from-p1',
            }),
          },
        ],
      });
    });

    expect((await screen.findAllByTestId('modificacao-entry')).length).toBe(1);
    expect(screen.queryByText(/Campos: stale/)).toBeNull();
  });
});
