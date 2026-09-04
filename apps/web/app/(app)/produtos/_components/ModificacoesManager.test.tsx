import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { FormProvider, useForm, type FieldValues, type UseFormReturn } from 'react-hook-form';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { Firestore, FirestoreError } from 'firebase/firestore';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';
import type { HistoricoModificacao } from '@delfrance/schemas';

// Hoisted mocks (vi.mock factories can't close over normal consts).
const h = vi.hoisted(() => ({
  getDocs: vi.fn(),
  getDoc: vi.fn(),
  buildRevertPrefill: vi.fn((): { key: string; value: unknown } => ({
    key: 'nome',
    value: 'Antigo',
  })),
  checkRevert: vi.fn(),
  isRevertible: vi.fn(() => ({ ok: true, reason: null }) as { ok: boolean; reason: string | null }),
  /** Re-declared here because the module under mock is fully replaced. */
  RevertPrefillError: class RevertPrefillError extends Error {},
  toasts: [] as Array<{ title?: string; message?: string }>,
  goToSection: vi.fn(),
  sectionOfField: vi.fn((key: string): string | null => (key === 'nome' ? 'Dados gerais' : null)),
  sections: {
    current: null as {
      activeSection: string | null;
      goToSection: (s: string) => void;
      sectionOfField: (k: string) => string | null;
    } | null,
  },
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

vi.mock('firebase/firestore', () => ({ getDocs: h.getDocs, getDoc: h.getDoc }));
vi.mock('@/lib/data/historicoModificacoesCollection', () => ({
  historicoModificacoesCollection: {
    resolvePath: () => 'produtos/p1/historicoDeModificacoes',
    ref: () => ({ __marker: 'ref' }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ __marker: 'docRef', id }),
  },
}));
vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: (args: { title?: string; message?: string }) =>
      h.toasts.push({ title: args.title, message: args.message }),
  },
}));
// The seeding reads' handles. Stubbed rather than built through the real
// `defineCollection`, which the `@delfrance/data` mock above does not provide.
vi.mock('@/lib/data/impostoProdutoCollection', () => ({
  impostoProdutoCollection: { ref: () => ({ __marker: 'impostoRef' }) },
}));
vi.mock('@/lib/data/operacaoCollection', () => ({
  operacaoCollection: { ref: () => ({ __marker: 'operacaoRef' }) },
}));
vi.mock('@/lib/data/produtoExtraDataCollection', () => ({
  produtoExtraDataCollection: {
    docRef: (_db: unknown, ctx: unknown, id: string) => ({ __marker: 'extraDataRef', ctx, id }),
  },
}));
// `ObjectView` publishes this in production; the tab optional-chains it, so a
// spy is what makes the "jump to the field's tab" half of a revert assertable.
vi.mock('@delfrance/ui', () => ({
  useObjectViewSections: () => h.sections.current,
}));
vi.mock('@/lib/produtos/revert', () => ({
  buildRevertPrefill: h.buildRevertPrefill,
  checkRevert: h.checkRevert,
  isRevertible: h.isRevertible,
  RevertPrefillError: h.RevertPrefillError,
}));
// The actor column reads `usuarios` behind a permission gate — a whole
// dependency chain (auth claims, TanStack, a second collection handle) that
// this suite is not about. Its own behaviour is covered in
// `components/UsuarioNome.test.tsx`.
vi.mock('@/components/UsuarioNome', () => ({
  UsuarioNome: () => null,
  useUsuarioNomes: () => ({}),
  uidFromUsuarioRef: () => null,
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

/**
 * The live form the tab stages into. `ObjectView` mounts the `FormProvider` in
 * production, so the harness does too — "Restaurar" writes into this form and
 * nowhere else, which is the whole point of #660.
 */
const formRef: { current: UseFormReturn<FieldValues> | null } = { current: null };

function Harness({ produtoId = 'p1', disabled }: { produtoId?: string; disabled?: boolean }) {
  const form = useForm<FieldValues>({
    defaultValues: { nome: 'Novo', extraData: null, impostos: null },
  });
  // From an effect, never during render — RHF's `form` is stable, and the
  // React Compiler rejects a render-phase write to an outer binding.
  useEffect(() => {
    formRef.current = form;
  }, [form]);
  return (
    <MantineTestProvider>
      <FormProvider {...form}>
        {/* Reading `isDirty` HERE is what subscribes the harness to it: RHF's
            formState is a proxy that only tracks the flags a render actually
            read, so asserting on `formRef.current.formState.isDirty` without
            this would report a stale `false`. */}
        <span data-testid="form-dirty">{String(form.formState.isDirty)}</span>
        <ModificacoesManager db={db} produtoId={produtoId} disabled={disabled} />
      </FormProvider>
    </MantineTestProvider>
  );
}

/** Whether the harness form holds unsaved edits, per its own subscription. */
function formIsDirty(): boolean {
  return screen.getByTestId('form-dirty').textContent === 'true';
}

function renderManager(entries: RawEntry[] = [], loading = false) {
  setSnap({ data: entries.map(toRow), loading });
  return render(<Harness />);
}

async function expandRow(index: number) {
  const toggles = await screen.findAllByRole('button', { name: 'Detalhes da modificação' });
  fireEvent.click(toggles[index]!);
}

beforeEach(() => {
  h.buildRevertPrefill.mockReturnValue({ key: 'nome', value: 'Antigo' });
  h.checkRevert.mockResolvedValue({ conflict: false, currentValue: 'Novo' });
  h.isRevertible.mockReturnValue({ ok: true, reason: null });
  h.sectionOfField.mockImplementation((key: string) => (key === 'nome' ? 'Dados gerais' : null));
  h.sections.current = {
    activeSection: 'Modificações',
    goToSection: h.goToSection,
    sectionOfField: h.sectionOfField,
  };
});

afterEach(() => {
  h.snapState.current = { data: undefined, loading: true, error: undefined };
  h.getDocs.mockReset();
  h.getDoc.mockReset();
  h.buildRevertPrefill.mockReset();
  h.checkRevert.mockReset();
  h.isRevertible.mockReset();
  h.goToSection.mockReset();
  h.sectionOfField.mockReset();
  h.sections.current = null;
  h.toasts.length = 0;
  formRef.current = null;
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
    render(<Harness />);
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
    rerender(<Harness />);

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

  /** One revertible produto-doc edit, the shape every staging test starts from. */
  const nomeUpdate: RawEntry = {
    id: 'evt-update',
    path: 'produtos/p1',
    subcolecao: null,
    docId: 'p1',
    kind: 'update',
    campos: ['nome'],
    timestamp: 1,
    changes: { nome: { old: 'Antigo', new: 'Novo' } },
  };

  async function clickRestaurar(field = 'nome') {
    await expandRow(0);
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: `Restaurar ${field}` }));
    });
  }

  it('stages the old value in the FORM and writes nothing (#660)', async () => {
    renderManager([nomeUpdate]);
    await clickRestaurar();

    // The form now holds the old value and is dirty — `ObjectView.doSave`
    // writes only dirty keys, so without the dirty flag it would never persist.
    expect(formRef.current?.getValues('nome')).toBe('Antigo');
    expect(formIsDirty()).toBe(true);
    // Nothing was written: staging is a pure form edit until "Salvar".
    expect(h.buildRevertPrefill).toHaveBeenCalledTimes(1);
    expect(h.getDoc).not.toHaveBeenCalled();
  });

  it('moves the operator to the tab that renders the staged field', async () => {
    renderManager([nomeUpdate]);
    await clickRestaurar();

    expect(h.sectionOfField).toHaveBeenCalledWith('nome');
    expect(h.goToSection).toHaveBeenCalledWith('Dados gerais');
  });

  it('stays put when the staged key has no tab of its own', async () => {
    h.sectionOfField.mockReturnValue(null);
    renderManager([nomeUpdate]);
    await clickRestaurar();

    expect(h.goToSection).not.toHaveBeenCalled();
  });

  it('says the value is staged, not saved — and stops saying so once the form is clean', async () => {
    renderManager([nomeUpdate]);
    await clickRestaurar();

    expect(await screen.findByText('Alterações não salvas')).toBeTruthy();
    expect(screen.getByText(/salve para aplicar/)).toBeTruthy();
    expect(h.toasts.at(-1)?.title).toBe('Valor restaurado no formulário');

    // A save resets the form to pristine — which is exactly when nothing is
    // staged any more, so the notes have to go with it.
    await act(async () => {
      formRef.current?.reset({ nome: 'Antigo', extraData: null, impostos: null });
    });
    await waitFor(() => {
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
    });
    expect(screen.queryByText(/salve para aplicar/)).toBeNull();
  });

  it('does not resurrect a committed note when the form goes dirty again', async () => {
    // `staged` is only ever added to, so a form-WIDE dirty gate would hide the
    // notes while pristine and bring every one of them back the moment the
    // operator touches any field — telling them a revert that was already
    // written is still unsaved. The gate has to be per-key.
    renderManager([nomeUpdate]);
    await clickRestaurar();
    expect(await screen.findByText('Alterações não salvas')).toBeTruthy();

    // Saved: the form resets to the persisted values and goes pristine.
    await act(async () => {
      formRef.current?.reset({ nome: 'Antigo', extraData: null, impostos: null });
    });
    await waitFor(() => {
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
    });

    // The operator now edits something ELSE — "Salvar e continuar" keeps them
    // on this screen, so this is the ordinary next move.
    await act(async () => {
      formRef.current?.setValue('sku', 'SKU-2', { shouldDirty: true });
    });

    expect(screen.queryByText('Alterações não salvas')).toBeNull();
    expect(screen.queryByText(/salve para aplicar/)).toBeNull();
  });

  it('drops a note when the operator types the staged field back by hand', async () => {
    renderManager([nomeUpdate]);
    await clickRestaurar();
    expect(await screen.findByText('Alterações não salvas')).toBeTruthy();

    // Undoing the staged edit leaves nothing staged, with no save involved.
    await act(async () => {
      formRef.current?.setValue('nome', 'Novo', { shouldDirty: true });
    });

    await waitFor(() => {
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
    });
    expect(screen.queryByText(/salve para aplicar/)).toBeNull();
  });

  it('retires an extraData note too, whose dirty flag is a nested shape', async () => {
    // `extraData` and `impostos` are ONE form key each holding a whole
    // object/array, so RHF tracks their dirtiness as a nested structure rather
    // than a boolean. A gate that only understood booleans would leave these
    // notes on screen for ever.
    h.buildRevertPrefill.mockReturnValue({
      key: 'extraData',
      value: { descricao: 'antiga', marca: 'M' },
    });
    h.sectionOfField.mockReturnValue('Descrição');
    // The Descrição tab has not been opened, so the staging path reads the
    // singleton itself before folding the revert into it.
    h.getDoc.mockResolvedValue({ data: () => ({}) });

    renderManager([
      {
        ...nomeUpdate,
        subcolecao: 'extraData',
        docId: 'singleton',
        campos: ['descricao'],
        changes: { descricao: { old: 'antiga', new: 'nova' } },
      },
    ]);
    await clickRestaurar('descricao');
    expect(await screen.findByText('Alterações não salvas')).toBeTruthy();

    await act(async () => {
      formRef.current?.reset({
        nome: 'Novo',
        extraData: { descricao: 'antiga', marca: 'M' },
        impostos: null,
      });
    });

    await waitFor(() => {
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
    });
  });

  it('warns before staging when the field moved again, then stages on confirm', async () => {
    h.checkRevert.mockResolvedValue({ conflict: true, currentValue: 'Mais Novo' });
    renderManager([nomeUpdate]);
    await clickRestaurar();

    // Advisory only — and more useful here than before a write was: nothing has
    // been staged yet, so the operator can still walk away.
    expect(await screen.findByText('Valor mudou desde a modificação')).toBeTruthy();
    expect(h.buildRevertPrefill).not.toHaveBeenCalled();
    expect(formIsDirty()).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restaurar mesmo assim' }));
    });
    expect(formRef.current?.getValues('nome')).toBe('Antigo');
    expect(formIsDirty()).toBe(true);
  });

  it('reports a revert that has nowhere to land instead of crashing', async () => {
    h.buildRevertPrefill.mockImplementation(() => {
      throw new h.RevertPrefillError('A operação deste imposto não está mais ativa');
    });
    renderManager([nomeUpdate]);
    await clickRestaurar();

    expect(h.toasts.at(-1)).toEqual({
      title: 'Falha ao restaurar',
      message: 'A operação deste imposto não está mais ativa',
    });
    expect(formIsDirty()).toBe(false);
  });

  it('offers no Restaurar to a viewer who could never save it', async () => {
    setSnap({ data: [nomeUpdate].map(toRow), loading: false });
    render(<Harness disabled />);
    await expandRow(0);

    expect(screen.queryByRole('button', { name: /^Restaurar/ })).toBeNull();
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
    rerender(<Harness />);

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
    rerender(<Harness produtoId="p2" />);

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
