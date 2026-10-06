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
import type { SaveChartInput, SavedChart } from '@/lib/mercado-livre/chartPersistence';
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
 * ⚠️ Deliberately silent about `busyChart`. There is no prop for it — driving it
 * means holding a `merge()` or a `sizeChartExcluir()` promise open — and the
 * pure test sweeps every busy state for free. Component tests earn their keep on
 * wiring, not on state the module already covers.
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
  sync: vi.fn<MercadoLivreClient['sizeChartSync']>(),
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
  tabelaDeMedidasCollection: { docRef: () => ({ __doc: 'tabMedi' }), merge: vi.fn() },
}));

vi.mock('@/lib/mercado-livre/chartPersistence', () => ({
  saveChartTransaction: (input: SaveChartInput) => h.save(input),
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
  useMercadoLivreClient: () => (h.hasClient ? { sizeChartSync: h.sync } : null),
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
  function Host() {
    // The manager reads `useFormContext` — `ObjectView` wraps every custom
    // `renderInput` in a `FormProvider`, so the test does too rather than
    // leaning on the null it would otherwise get.
    const form = useForm({ defaultValues: {} });
    return (
      <FormProvider {...form}>
        <MedidasMercadoLivreManager tabMediId="tab-1" db={{} as Firestore} disabled={disabled} />
      </FormProvider>
    );
  }
  const tree = () => (
    <MantineTestProvider>
      <Host />
    </MantineTestProvider>
  );
  const rendered = render(tree());
  return { refresh: () => rendered.rerender(tree()) };
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
  h.sync.mockReset();
  h.save.mockImplementation((input) =>
    Promise.resolve({
      tabelas: [input.chart],
      index: input.chartIndex ?? 0,
      chart: input.chart,
    }),
  );
  h.sync.mockImplementation((input) =>
    Promise.resolve({ tabelas: input.tabelas, validationErrors: [], updated: false }),
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

  it('waits for the transaction result and sends its committed whole list exactly once', async () => {
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
      tabelas: [edited, other],
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
    h.sync.mockResolvedValueOnce({
      tabelas: [GUIA_ENVIADA, canonical],
      validationErrors: errors,
      updated: true,
    });

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
    h.sync.mockResolvedValue({ ...response, validationErrors: [], updated: true });
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
});
