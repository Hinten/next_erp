import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';

// Hoisted mocks (vi.mock factories can't close over normal consts).
const h = vi.hoisted(() => ({
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  applyRevert: vi.fn(),
  checkRevert: vi.fn(),
  isRevertible: vi.fn(() => ({ ok: true, reason: null }) as { ok: boolean; reason: string | null }),
}));

// This test forces the CLASSIC query path (`isPipelineSupported: () => false`)
// so it never touches the real `firebase/firestore/pipelines` machinery — the
// list/expand fetches are exercised through plain `getDocs`/`getDoc` stubs
// instead. Kept as a full replacement (not `importOriginal`) so no real
// Firestore SDK call is reachable from this test's module graph.
vi.mock('@delfrance/data', () => ({
  PIPELINE_ID_FIELD: 'rowId',
  PipelineUnsupportedError: class PipelineUnsupportedError extends Error {},
  buildPipeline: vi.fn(),
  buildQuery: (base: unknown, constraints: unknown[]) => ({ base, constraints }),
  isPipelineSupported: () => false,
  orderByField: vi.fn(),
  paginate: vi.fn(() => []),
}));
vi.mock('firebase/firestore', () => ({ getDoc: h.getDoc, getDocs: h.getDocs }));
vi.mock('firebase/firestore/pipelines', () => ({ execute: vi.fn() }));
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

function docsSnapshot(entries: RawEntry[]) {
  return {
    docs: entries.map((e) => ({
      id: e.id,
      data: () => ({
        path: e.path,
        subcolecao: e.subcolecao,
        docId: e.docId,
        kind: e.kind,
        campos: e.campos,
        timestamp: e.timestamp,
      }),
    })),
  };
}

/** `getDoc` resolves the full doc (incl. `changes`) for whichever id was requested. */
function wireGetDoc(entries: RawEntry[]) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  h.getDoc.mockImplementation((ref: { id: string }) =>
    Promise.resolve({ data: () => ({ changes: byId.get(ref.id)?.changes ?? {} }) }),
  );
}

function renderManager(entries: RawEntry[]) {
  h.getDocs.mockResolvedValue(docsSnapshot(entries));
  wireGetDoc(entries);
  render(
    <MantineProvider>
      <ModificacoesManager db={db} produtoId="p1" />
    </MantineProvider>,
  );
}

async function expandRow(index: number) {
  const toggles = await screen.findAllByRole('button', { name: 'Detalhes da modificação' });
  fireEvent.click(toggles[index]!);
}

describe('ModificacoesManager', () => {
  it('shows the empty state when there is no history yet', async () => {
    renderManager([]);
    expect(await screen.findByText('Nenhuma modificação registrada.')).toBeTruthy();
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

  it('shows an enabled Restaurar for a whitelisted update field', async () => {
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

    const button = (await screen.findByRole('button', {
      name: 'Restaurar nome',
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
