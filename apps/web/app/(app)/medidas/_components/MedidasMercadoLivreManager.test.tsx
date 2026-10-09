import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import type { ComponentProps } from 'react';
import { deferred } from '@delfrance/data/testing';
import type { MlSizeChart } from '@delfrance/schemas';
import {
  MercadoLivreClientNetworkError,
  MercadoLivreClientHttpError,
  type MercadoLivreClient,
} from '@/lib/mercado-livre/client';
import type {
  SaveChartInput,
  SavedChart,
  RemoveChartDraftsInput,
} from '@/lib/mercado-livre/chartPersistence';
import { AfterSaveBlockedError } from '@delfrance/ui';
import {
  SizeChartConflictError,
  SizeChartSyncUnconfirmedError,
} from '@/lib/mercado-livre/chartConflict';

import { MantineTestProvider } from '@/lib/testing/mantine';
import { SIZE_CHART_MOTIVOS } from '@/lib/mercado-livre/sizeChartDisabled';

/**
 * What this file pins that `sizeChartDisabled.test.ts` cannot: that the right
 * gate reached the right control. The pure test proves the four decisions; this
 * one proves the wiring, and that each message is REACHABLE on the control it
 * belongs to rather than merely somewhere on the page.
 *
 * Staged-removal tests also pin the flush/dirty integration and snapshot-independent previews.
 */

type EditorProps = ComponentProps<typeof import('./SizeChartEditorModal').SizeChartEditorModal>;

const h = vi.hoisted(() => ({
  canRead: true,
  canWrite: true,
  permsLoading: false,
  hasClient: true,
  contas: [] as unknown[],
  grupos: [] as unknown[],
  charts: {} as Record<string, unknown>,
  editor: null as EditorProps | null,
  save: vi.fn<(input: SaveChartInput) => Promise<SavedChart>>(),
  remove: vi.fn<(input: RemoveChartDraftsInput) => Promise<Record<string, MlSizeChart[]>>>(),
  merge: vi.fn(),
  exclude: vi.fn<MercadoLivreClient['sizeChartExcluir']>(),
  verify: vi.fn<MercadoLivreClient['sizeChartVerificarExclusao']>(),
  sync: vi.fn<MercadoLivreClient['sizeChartSync']>(),
  syncStatus: vi.fn<MercadoLivreClient['sizeChartSyncStatus']>(),
  recover: vi.fn<MercadoLivreClient['sizeChartRecover']>(),
}));

const CONTA = { id: 'conta-1', path: 'integracao/conta-1', data: { nome: 'Loja Teste' } };
const GRUPO = {
  id: 'grupo-1',
  path: 'grupoDeVariacoes/grupo-1',
  data: { nome: 'Tamanhos', variacoes: [{ id: 'v1', nome: 'P' }] },
};

vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

// `ref`/`docRef` run inside `useMemo` at RENDER time, and the real ones call
// into the Firestore SDK, which rejects a stub `db`. The tag is what lets the
// `useSnapshot` mock below tell the two queries apart.
vi.mock('@/lib/data/integracaoCollection', () => ({
  integracaoCollection: { ref: () => ({ __col: 'integracao' }) },
}));
vi.mock('@/lib/data/grupoDeVariacoesCollection', () => ({
  grupoDeVariacoesCollection: { ref: () => ({ __col: 'grupoDeVariacoes' }) },
}));
vi.mock('@/lib/data/tabelaDeMedidasCollection', () => ({
  tabelaDeMedidasCollection: { docRef: () => ({ __doc: 'tabMedi' }), merge: h.merge },
}));

vi.mock('@/lib/mercado-livre/chartPersistence', () => ({
  saveChartTransaction: (input: SaveChartInput) => h.save(input),
  removeChartDraftsTransaction: (input: RemoveChartDraftsInput) => h.remove(input),
}));

// Pass the tagged ref straight through — the constraints are inert here.
vi.mock('@delfrance/data', () => ({
  buildQuery: (base: unknown) => base,
  limit: () => ({}),
  orderByField: () => ({}),
  whereEqual: () => ({}),
}));

vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: (q: { __col?: string } | null) =>
    q == null
      ? { data: undefined, loading: false, error: undefined }
      : {
          data: q.__col === 'grupoDeVariacoes' ? h.grupos : h.contas,
          loading: false,
          error: undefined,
        },
  useDocSnapshot: () => ({
    data: { id: 'tab-1', data: { tabelasDeMedidasMercadoLivre: h.charts } },
    loading: false,
    error: undefined,
  }),
}));

// ⚠️ `loading` is returned EXPLICITLY. `AuthProvider`'s context default is
// `{ user: null, loading: true }`, so a mock that only answers `allowed` leaves
// `loading` undefined — falsy, so it happens to work, and silently stops
// working the day a test wants to assert the loading branch.
vi.mock('@/lib/auth', () => ({
  usePermission: (bit: bigint) => ({
    allowed: bit === PERM.integracao.read ? h.canRead : h.canWrite,
    loading: h.permsLoading,
  }),
}));

vi.mock('@/lib/mercado-livre/client', async (importOriginal) => ({
  // `describeChartError` narrows on the real error classes (rule 6), so the
  // module is kept whole and only the hook is replaced.
  ...(await importOriginal<typeof import('@/lib/mercado-livre/client')>()),
  useMercadoLivreClient: () =>
    h.hasClient
      ? {
          sizeChartSync: h.sync,
          sizeChartSyncStatus: h.syncStatus,
          sizeChartRecover: h.recover,
          sizeChartExcluir: h.exclude,
          sizeChartVerificarExclusao: h.verify,
        }
      : null,
}));

// Probe the manager callbacks; the real modal owns its own input/error tests.
vi.mock('./SizeChartEditorModal', () => ({
  SizeChartEditorModal: (props: EditorProps) => {
    h.editor = props;
    return <input aria-label="Draft cell" defaultValue="01" />;
  },
}));

const { MedidasMercadoLivreManager } = await import('./MedidasMercadoLivreManager');

const GUIA_ENVIADA = {
  id: 'MLB-CHART-1',
  nome: 'Camisetas',
  domain_id: 'MLB-T_SHIRTS',
  rows: [{ id: 'MLB-CHART-1:1' }],
};
const GUIA_EM_EXCLUSAO = { ...GUIA_ENVIADA, exclusaoSolicitadaEm: 1_700_000_000_000 };

function show(disabled = false) {
  const flushRef: { current: (() => Promise<void>) | null } = { current: null };
  const onDirtyChange = vi.fn();
  function Host() {
    // The manager reads `useFormContext` — `ObjectView` wraps every custom
    // `renderInput` in a `FormProvider`, so the test does too rather than
    // leaning on the null it would otherwise get.
    const form = useForm({ defaultValues: {} });
    return (
      <FormProvider {...form}>
        <MedidasMercadoLivreManager
          tabMediId="tab-1"
          db={{} as Firestore}
          disabled={disabled}
          flushRef={flushRef}
          onDirtyChange={onDirtyChange}
        />
      </FormProvider>
    );
  }
  const tree = () => (
    <MantineTestProvider>
      <Host />
    </MantineTestProvider>
  );
  const rendered = render(tree());
  return {
    refresh: () => rendered.rerender(tree()),
    flushRef,
    onDirtyChange,
    unmount: rendered.unmount,
  };
}

const guia = (index = 0) => screen.getByTestId(`ml-guia-conta-1-${String(index)}`);
const botao = (nome: string, scope: HTMLElement = document.body) =>
  within(scope).getByRole('button', { name: nome });

/**
 * Hovering the control must ADD one occurrence of the message.
 *
 * ⚠️ A plain `getByText` would be vacuous here: `semEscrita` and `semGrupos` are
 * also rendered as standing `<Text c="dimmed">` guidance on the card, so they
 * are on the page whether or not the tooltip can ever open. Counting is what
 * distinguishes "reachable" from "present".
 *
 * The hover goes on the wrapper `<span>` — floating-ui registers `mouseenter`
 * natively on the reference element, and it does not bubble up from the button.
 */
async function revela(button: HTMLElement, motivo: string): Promise<void> {
  expect(button.hasAttribute('disabled')).toBe(true);
  const antes = screen.queryAllByText(motivo).length;
  const wrapper = button.parentElement;
  expect(wrapper).not.toBeNull();
  fireEvent.mouseEnter(wrapper!);
  await waitFor(() => {
    expect(screen.queryAllByText(motivo).length).toBe(antes + 1);
  });
  // Close it again so the next hover in the same test starts from a clean count.
  fireEvent.mouseLeave(wrapper!);
}

beforeEach(() => {
  h.canRead = true;
  h.canWrite = true;
  h.permsLoading = false;
  h.hasClient = true;
  h.contas = [CONTA];
  h.grupos = [GRUPO];
  h.charts = { 'conta-1': { tabelas: [GUIA_EM_EXCLUSAO] } };
  h.editor = null;
  h.save.mockReset();
  h.merge.mockReset();
  h.exclude.mockReset();
  h.verify.mockReset();
  h.remove.mockReset();
  h.remove.mockImplementation((input) => {
    const lists: Record<string, MlSizeChart[]> = {};
    for (const { integracaoId } of input.removals) {
      const entry = h.charts[integracaoId] as { tabelas: MlSizeChart[] };
      lists[integracaoId] = entry.tabelas.filter(
        (_, index) =>
          !input.removals.some((r) => r.integracaoId === integracaoId && r.chartIndex === index),
      );
    }
    return Promise.resolve(lists);
  });
  h.sync.mockReset();
  h.syncStatus.mockReset();
  h.recover.mockReset();
  h.recover.mockResolvedValue({ released: true, chart: null, chartIndex: 0 });
  h.syncStatus.mockResolvedValue({ operation: null });
  h.save.mockImplementation((input) =>
    Promise.resolve({
      tabelas: [input.chart],
      index: input.chartIndex ?? 0,
      chart: input.chart,
    }),
  );
  h.sync.mockImplementation((input) =>
    Promise.resolve({
      operationId: input.operationId,
      chartIndex: input.chartIndex,
      status: 'completed',
      tabelas: Array.from({ length: input.chartIndex + 1 }, (_, i) =>
        i === input.chartIndex ? input.chart : {},
      ),
      validationErrors: [],
      updated: false,
    }),
  );
});

describe('MedidasMercadoLivreManager — why a control is off', () => {
  it('leaves every control open when nothing blocks it', () => {
    show();
    for (const nome of ['Verificar', 'Editar', 'Excluir']) {
      expect(botao(nome, guia()).hasAttribute('disabled')).toBe(false);
    }
    expect(botao('Nova guia').hasAttribute('disabled')).toBe(false);
  });

  /**
   * ⚠️ The permission gap the card already mentioned — but only in a line at the
   * bottom, never on the two controls it actually stops. Editar and Nova guia
   * only OPEN the editor, so they stay clickable: the gate is per action, not
   * per card.
   */
  it('names the integrações gap on the two controls it blocks, and only those', async () => {
    h.canWrite = false;
    show();

    await revela(botao('Verificar', guia()), SIZE_CHART_MOTIVOS.semEscrita);
    await revela(botao('Excluir', guia()), SIZE_CHART_MOTIVOS.semEscrita);

    expect(botao('Editar', guia()).hasAttribute('disabled')).toBe(false);
    expect(botao('Nova guia').hasAttribute('disabled')).toBe(false);
  });

  /**
   * ⚠️ One of the two causes that said NOTHING before. It is ObjectView's
   * `readOnly`, which on this page is `!usePermission(PERM.produto.write)` — a
   * different bit from the integrações one the card talks about, which is
   * exactly why the silent version was unguessable.
   */
  it('explains the read-only form on all four controls', async () => {
    show(true);

    for (const nome of ['Verificar', 'Editar', 'Excluir']) {
      await revela(botao(nome, guia()), SIZE_CHART_MOTIVOS.somenteLeitura);
    }
    await revela(botao('Nova guia'), SIZE_CHART_MOTIVOS.somenteLeitura);
  });

  /** The other silent one — and it must not be reported as a permission gap. */
  it('explains a missing client as a session to re-establish', async () => {
    h.hasClient = false;
    h.canWrite = false;
    show(true);

    await revela(botao('Editar', guia()), SIZE_CHART_MOTIVOS.semSessao);
    expect(screen.queryAllByText(SIZE_CHART_MOTIVOS.somenteLeitura)).toHaveLength(0);
  });

  it('keeps the variation-group guidance visible AND puts it on Nova guia', async () => {
    h.grupos = [];
    show();

    // Standing guidance survives: it says what to go and create, and a tooltip
    // needs a hover to be found.
    expect(screen.queryAllByText(SIZE_CHART_MOTIVOS.semGrupos)).toHaveLength(1);
    await revela(botao('Nova guia'), SIZE_CHART_MOTIVOS.semGrupos);
    // Scoped to Nova guia — a missing group blocks creating a guia, not editing
    // one that already exists.
    expect(botao('Editar', guia()).hasAttribute('disabled')).toBe(false);
  });

  /**
   * ⚠️ `verifyDeletion` returns immediately when the guia carries no ML chart
   * id, so this button used to be ENABLED and do nothing — a dead control that
   * looks like it worked. Unreachable through this app, but the migrated corpus
   * is not this app's output.
   */
  it('closes Verificar on a guia Mercado Livre never received', async () => {
    h.charts = { 'conta-1': { tabelas: [{ ...GUIA_EM_EXCLUSAO, id: null }] } };
    show();

    await revela(botao('Verificar', guia()), SIZE_CHART_MOTIVOS.naoEnviada);
  });

  /**
   * ⚠️ `usePermission` answers `allowed: false` WHILE the claims resolve, and
   * the `!canRead` return used to sit ahead of the loading check — so every
   * ordinary page load flashed a permission denial at an operator who has the
   * bit.
   */
  it('waits for the claims instead of denying permission it has not read yet', () => {
    h.permsLoading = true;
    h.canRead = false;
    show();

    expect(screen.queryByText(/Requer permissão de leitura/)).toBeNull();
    expect(screen.queryByTestId('ml-medida-conta-conta-1')).toBeNull();
  });

  it('still reports a real read gap once the claims land', () => {
    h.canRead = false;
    show();

    expect(screen.getByText(/Requer permissão de leitura/)).not.toBeNull();
  });
});

describe('MedidasMercadoLivreManager — staged draft removal', () => {
  const draft = { ...GUIA_ENVIADA, id: null };
  beforeEach(() => {
    h.charts = { 'conta-1': { tabelas: [draft] } };
  });

  it('stages visibly without a write or confirmation, and undo restores a clean page', () => {
    const view = show();
    fireEvent.click(botao('Excluir', guia()));
    expect(within(guia()).getByText('Será excluída ao salvar')).toBeTruthy();
    expect(botao('Editar', guia()).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(view.onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.exclude).not.toHaveBeenCalled();
    fireEvent.click(botao('Desfazer', guia()));
    expect(within(guia()).getByText('Rascunho')).toBeTruthy();
    expect(view.onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('captures independent baselines for several accounts and clears them only after a successful flush', async () => {
    const other = { ...CONTA, id: 'conta-2' };
    h.contas = [CONTA, other];
    h.charts[other.id] = { tabelas: [draft] };
    const view = show();
    fireEvent.click(botao('Excluir', guia()));
    fireEvent.click(botao('Excluir', screen.getByTestId('ml-guia-conta-2-0')));
    await act(async () => {
      await view.flushRef.current!();
    });
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(h.remove.mock.calls[0]![0]).toMatchObject({
      tabMediId: 'tab-1',
      removals: [
        { integracaoId: 'conta-1', chartIndex: 0, original: draft },
        { integracaoId: 'conta-2', chartIndex: 0, original: draft },
      ],
    });
    expect(view.onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText('Será excluída ao salvar')).toBeNull();
    expect(screen.queryByTestId('ml-guia-conta-1-0')).toBeNull();
    expect(h.exclude).not.toHaveBeenCalled();
    await act(async () => {
      await view.flushRef.current!();
    });
    expect(h.remove).toHaveBeenCalledTimes(1);
  });

  it.each(['edited', 'moved', 'missing'])(
    'retains the original preview when the target becomes %s',
    async (change) => {
      const view = show();
      fireEvent.click(botao('Excluir', guia()));
      const changed = { ...draft, nome: 'Remota', rows: [] };
      h.charts = {
        'conta-1': {
          tabelas: change === 'edited' ? [changed] : change === 'moved' ? [changed, draft] : [],
        },
      };
      view.refresh();
      const preview = screen.getByTestId('ml-guia-pendente-conta-1-0');
      expect(within(preview).getByText(draft.nome)).toBeTruthy();
      if (change !== 'missing')
        expect(within(guia()).queryByText('Será excluída ao salvar')).toBeNull();
      h.remove.mockRejectedValueOnce(new SizeChartConflictError());
      await act(async () => {
        await expect(view.flushRef.current!()).rejects.toBeInstanceOf(AfterSaveBlockedError);
      });
      expect(h.remove.mock.calls[0]![0].removals[0]!.original).toEqual(draft);
      expect(screen.getByRole('alert').textContent).toContain('Desfaça as exclusões pendentes');
      expect(screen.getByRole('alert').textContent).toContain('Alterações já salvas');
      view.refresh();
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(view.onDirtyChange).toHaveBeenLastCalledWith(true);
      fireEvent.click(botao('Desfazer', preview));
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  it('locks undo and competing list controls for the entire flush', async () => {
    h.charts = { 'conta-1': { tabelas: [draft, GUIA_EM_EXCLUSAO] } };
    const view = show();
    fireEvent.click(botao('Excluir', guia()));
    const pending = deferred<Record<string, MlSizeChart[]>>();
    h.remove.mockReturnValueOnce(pending.promise);
    let saving: Promise<void>;
    act(() => {
      saving = view.flushRef.current!();
    });
    for (const button of ['Desfazer', 'Editar'])
      expect(botao(button, guia()).hasAttribute('disabled')).toBe(true);
    for (const button of ['Verificar', 'Excluir', 'Editar'])
      expect(botao(button, guia(1)).hasAttribute('disabled')).toBe(true);
    expect(botao('Nova guia').hasAttribute('disabled')).toBe(true);
    await act(async () => {
      pending.resolve({ 'conta-1': [GUIA_EM_EXCLUSAO] });
      await saving!;
    });
    expect(botao('Nova guia').hasAttribute('disabled')).toBe(false);
  });

  it('keeps conflict feedback while the failed batch still has pending removals', async () => {
    h.charts = { 'conta-1': { tabelas: [draft, { ...draft, nome: 'Segunda' }] } };
    const view = show();
    fireEvent.click(botao('Excluir', guia()));
    h.remove.mockRejectedValueOnce(new SizeChartConflictError());
    await act(async () => {
      await expect(view.flushRef.current!()).rejects.toBeInstanceOf(AfterSaveBlockedError);
    });
    fireEvent.click(botao('Excluir', guia(1)));
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(botao('Desfazer', guia(1)));
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(botao('Desfazer', guia()));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('propagates unexpected failures and retains pending work; unmount unregisters the flush', async () => {
    const view = show();
    fireEvent.click(botao('Excluir', guia()));
    const failure = new TypeError('Unexpected failure');
    h.remove.mockRejectedValueOnce(failure);
    await act(async () => {
      await expect(view.flushRef.current!()).rejects.toBe(failure);
    });
    expect(within(guia()).getByText('Será excluída ao salvar')).toBeTruthy();
    view.unmount();
    expect(view.flushRef.current).toBeNull();
    expect(view.onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});

describe('MedidasMercadoLivreManager — guarded persistence', () => {
  const edited: MlSizeChart = { ...GUIA_ENVIADA, nome: 'Editada' };

  function openExisting() {
    const view = show();
    fireEvent.click(botao('Editar', guia()));
    expect(h.editor).not.toBeNull();
    return view;
  }

  it('saves a draft through the guarded port and advances its confirmed baseline', async () => {
    openExisting();
    await act(async () => {
      await h.editor!.onSaveDraft(edited, 0);
    });
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({ original: GUIA_EM_EXCLUSAO, chart: edited, chartIndex: 0 }),
    );
    expect(h.editor?.chart).toEqual(edited);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it('preserves input and never calls Mercado Livre when the local transaction reports a conflict', async () => {
    openExisting();
    const input = screen.getByLabelText('Draft cell');
    fireEvent.change(input, { target: { value: '90,5' } });
    h.save.mockRejectedValue(new SizeChartConflictError());

    await act(async () => {
      await expect(h.editor!.onSend(edited, 0)).rejects.toBeInstanceOf(SizeChartConflictError);
    });

    expect(h.sync).not.toHaveBeenCalled();
    expect(h.editor?.chart).toEqual(GUIA_EM_EXCLUSAO);
    expect(screen.getByLabelText('Draft cell')).toBe(input);
    expect((input as HTMLInputElement).value).toBe('90,5');
  });

  it('waits for the transaction result and sends only the committed target exactly once', async () => {
    openExisting();
    const pending = deferred<SavedChart>();
    const other = { ...GUIA_ENVIADA, id: 'OTHER', nome: 'Outra guia' };
    h.save.mockReturnValue(pending.promise);
    const send = h.editor!.onSend(edited, 0);
    expect(h.sync).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ tabelas: [edited, other], index: 0, chart: edited });
      await send;
    });

    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.sync).toHaveBeenCalledWith({
      integracaoId: 'conta-1',
      tabMediId: 'tab-1',
      chart: edited,
      chartIndex: 0,
      operationId: expect.any(String),
      recoveryChartId: null,
    });
  });

  it('adopts partial-sync ids without remounting or appending the new guide again', async () => {
    const view = show();
    fireEvent.click(botao('Nova guia'));
    const input = screen.getByLabelText('Draft cell');
    fireEvent.change(input, { target: { value: '90,5' } });
    const draft: MlSizeChart = { id: null, nome: 'Nova guia', rows: [{ id: null }] };
    const canonical: MlSizeChart = {
      ...draft,
      id: 'NEW-CHART',
      rows: [{ id: 'NEW-CHART:1' }],
    };
    const errors = [
      {
        chartIndex: 1,
        code: 'required_row_attribute_not_found',
        message: 'Missing size',
        rowIndex: 0,
        attributeIds: ['SIZE'],
        rowMainValue: null,
      },
    ];
    h.save.mockResolvedValueOnce({ tabelas: [GUIA_ENVIADA, draft], index: 1, chart: draft });
    h.sync.mockImplementationOnce((input) =>
      Promise.resolve({
        operationId: input.operationId,
        chartIndex: 1,
        status: 'validation',
        tabelas: [GUIA_ENVIADA, canonical],
        validationErrors: errors,
        updated: true,
      }),
    );

    await act(async () => {
      expect(await h.editor!.onSend(draft, null)).toEqual({
        validationErrors: errors,
        chartIndex: 1,
        chart: canonical,
      });
    });

    expect(h.editor?.chartIndex).toBe(1);
    expect(h.editor?.chart).toEqual(canonical);
    expect(screen.getByLabelText('Draft cell')).toBe(input);
    expect((input as HTMLInputElement).value).toBe('90,5');

    // A live snapshot is a contender, not permission to advance the open baseline.
    h.charts = { 'conta-1': { tabelas: [{ ...canonical, nome: 'Mudança remota' }] } };
    view.refresh();
    const corrected = { ...canonical, nome: 'Corrigida' };
    h.save.mockResolvedValueOnce({
      tabelas: [GUIA_ENVIADA, corrected],
      index: 1,
      chart: corrected,
    });
    await act(async () => {
      await h.editor!.onSend(corrected, h.editor!.chartIndex);
    });
    expect(h.save.mock.calls[1]?.[0]).toMatchObject({
      chartIndex: 1,
      original: canonical,
      chart: corrected,
    });
  });

  it.each([
    { tabelas: [] },
    { tabelas: [{ id: 42 }] },
    { tabelas: [{}] },
    { tabelas: [{ ...edited, id: 'OTHER-CHART' }] },
    { tabelas: [{ ...edited, nome: 'Outra guia' }] },
    { tabelas: [{ ...edited, domain_id: 'MLB-PANTS' }] },
  ])('keeps the last local baseline after an unreadable sync response: %j', async (response) => {
    openExisting();
    h.sync.mockImplementation((input) =>
      Promise.resolve({
        ...response,
        operationId: input.operationId,
        chartIndex: input.chartIndex,
        status: 'completed',
        validationErrors: [],
        updated: true,
      }),
    );
    await act(async () => {
      await expect(h.editor!.onSend(edited, 0)).rejects.toBeInstanceOf(SizeChartConflictError);
    });
    expect(h.editor?.chart).toEqual(edited);
    expect(h.editor?.chartIndex).toBe(0);
  });

  it('keeps the saved draft baseline when the sync request fails', async () => {
    openExisting();
    const failure = new MercadoLivreClientNetworkError(
      'Failed to fetch',
      new TypeError('Network disconnected'),
    );
    h.sync.mockRejectedValue(failure);
    await act(async () => {
      await expect(h.editor!.onSend(edited, 0)).rejects.toBe(failure);
    });
    expect(h.editor?.chart).toEqual(edited);
    expect(h.sync).toHaveBeenCalledTimes(1);
  });

  it('explains an unconfirmed send when persisted partial row ids make the retry conflict', async () => {
    openExisting();
    const input = screen.getByLabelText('Draft cell');
    fireEvent.change(input, { target: { value: '90,5' } });
    const draft = { ...edited, rows: [{ id: 'MLB-CHART-1:1' }, { id: null }] };
    const partial = {
      ...draft,
      rows: [{ id: 'MLB-CHART-1:1' }, { id: 'MLB-CHART-1:2' }],
    };
    const failure = new MercadoLivreClientHttpError('Unavailable', 503, null);
    h.sync.mockImplementationOnce(() => {
      h.charts = { 'conta-1': { tabelas: [partial] } };
      return Promise.reject(failure);
    });

    await act(async () => {
      await expect(h.editor!.onSend(draft, 0)).rejects.toBe(failure);
    });
    expect(h.editor?.chart).toEqual(draft);
    h.save.mockRejectedValueOnce(new SizeChartConflictError());
    await act(async () => {
      await expect(h.editor!.onSend(draft, 0)).rejects.toBeInstanceOf(
        SizeChartSyncUnconfirmedError,
      );
    });
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.editor?.chart).toEqual(draft);
    expect(screen.getByLabelText('Draft cell')).toBe(input);
    expect((input as HTMLInputElement).value).toBe('90,5');
  });

  it('still retries a failed send when the saved chart did not change', async () => {
    openExisting();
    const failure = new MercadoLivreClientHttpError('Rate limit', 429, null);
    h.sync.mockRejectedValueOnce(failure);
    await act(async () => {
      await expect(h.editor!.onSend(edited, 0)).rejects.toBe(failure);
    });
    await act(async () => {
      await expect(h.editor!.onSend(edited, 0)).resolves.toMatchObject({ chart: edited });
    });
    expect(h.sync).toHaveBeenCalledTimes(2);
  });

  it('persists the draft before a failed recovery-status lookup', async () => {
    openExisting();
    const failure = new MercadoLivreClientNetworkError('Offline', new TypeError('Offline'));
    h.syncStatus.mockRejectedValueOnce(failure);
    await act(async () => {
      await expect(h.editor!.onSend(edited, 0)).rejects.toBe(failure);
    });
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.editor?.chart).toEqual(edited);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it('recovers partial IDs with the original operation instead of saving a stale retry', async () => {
    openExisting();
    const chart = { ...edited, rows: [{ id: 'MLB-CHART-1:1' }, { id: null }] };
    const projected = { ...chart, rows: [{ id: 'MLB-CHART-1:1' }, { id: 'MLB-CHART-1:2' }] };
    const failure = new MercadoLivreClientNetworkError('Offline', new TypeError('Offline'));
    h.sync.mockRejectedValueOnce(failure);
    await act(async () => {
      await expect(h.editor!.onSend(chart, 0)).rejects.toBe(failure);
    });
    const id = h.sync.mock.calls[0]![0].operationId;
    h.syncStatus.mockResolvedValueOnce({
      operation: { operationId: id, chartIndex: 0, chart, projected, status: 'unconfirmed' },
    });
    h.sync.mockResolvedValueOnce({
      operationId: id,
      chartIndex: 0,
      status: 'completed',
      tabelas: [projected],
      validationErrors: [],
      updated: true,
    });
    await act(async () => {
      await expect(h.editor!.onSend(chart, 0)).resolves.toMatchObject({ chart: projected });
    });
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.sync.mock.calls[1]![0]).toMatchObject({ operationId: id, chart });
    expect(h.editor?.chart).toEqual(projected);
  });

  it('releases an uncertain attempt through the product without resending or losing typed input', async () => {
    openExisting();
    const input = screen.getByLabelText('Draft cell');
    fireEvent.change(input, { target: { value: '99,5' } });
    const failure = new MercadoLivreClientHttpError('Unavailable', 503, null);
    h.sync.mockRejectedValueOnce(failure);
    await act(async () => {
      await expect(h.editor!.onSend(edited, 0)).rejects.toBe(failure);
    });
    const id = h.sync.mock.calls[0]![0].operationId;
    h.syncStatus.mockResolvedValueOnce({
      operation: {
        operationId: id,
        chartIndex: 0,
        chart: GUIA_ENVIADA,
        projected: GUIA_ENVIADA,
        status: 'unconfirmed',
        kind: 'sync',
      },
    });
    await act(async () => {
      await h.editor!.onRecover!(true);
    });
    expect(h.recover).toHaveBeenCalledWith({
      integracaoId: 'conta-1',
      tabMediId: 'tab-1',
      operationId: id,
      expectedChart: edited,
      recoveryChartId: null,
      confirmNoCreation: true,
    });
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.editor?.recoveryRequired).toBe(false);
    expect(screen.getByLabelText('Draft cell')).toBe(input);
    expect((input as HTMLInputElement).value).toBe('99,5');
  });
});
