import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormEvent } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { FirebaseError } from 'firebase/app';
import { MantineTestProvider } from '@/lib/testing/mantine';
import {
  ESTADO_FRETE,
  type EstadoFrete,
  ORIGEM_INCIDENTE,
  TIPO_INCIDENTE,
  type Incidente,
} from '@delfrance/schemas';
import { IncidenteConflictError, IncidenteMissingError } from '@/lib/pedidos/saveIncidenteEdit';
import { IncidentesTab, type IncidenteFlush } from './IncidentesTab';
import { ORIGEM_EXCLUSIVA_MSG } from './incidenteForm';

// #374: legacy `bloquear` (`pedidoCadastro.dart:1437-1450`) locks the 3
// incidente-level fields — Tipo, Motivo, Comentários — once the resolução's
// return-shipping (`resolucao.frete.estado`) has moved past `iniciado`. The
// resolução-level fields already honoured `isResolucaoLocked` (`resFieldsDisabled`
// at IncidentesTab.tsx:167); the 3 incidente-level fields still only respected
// `disabled`. `origem` intentionally stays untouched — it has no field in the
// legacy widget either, per the parity audit comment on the issue.

// Hoisted mock (vi.mock factories can't close over a normal const).
const { snapState } = vi.hoisted(() => ({
  snapState: {
    current: {
      data: undefined as Array<{ id: string; data: unknown }> | undefined,
      loading: false,
      error: undefined as Error | undefined,
    },
  },
}));

vi.mock('@delfrance/data', () => ({
  buildQuery: () => ({ __fakeQuery: true }),
  orderByField: () => ({ __c: 'orderBy' }),
}));
vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: () => snapState.current,
}));
vi.mock('@delfrance/data/pedido', () => ({
  saveIncidente: vi.fn(),
  deleteIncidente: vi.fn(),
}));
vi.mock('@/lib/data/incidenteCollection', () => ({
  incidenteCollection: { ref: () => ({}) },
}));
vi.mock('@/lib/pedidos/clientPort', () => ({ createClientPedidoPort: () => ({}) }));
vi.mock('@/lib/pedidos/incidentePort', () => ({ createClientIncidentePort: () => ({}) }));
// Partial: the component narrows on the real error CLASSES with `instanceof`,
// so only the use-case function is faked.
vi.mock('@/lib/pedidos/saveIncidenteEdit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pedidos/saveIncidenteEdit')>()),
  saveIncidenteEdit: vi.fn(),
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
// The channel panels are tested on their own; here only WHICH one mounts, and
// with what, matters. Each stub prints the props it was handed.
vi.mock('../ReclamacaoMlPanel', () => ({
  ReclamacaoMlPanel: (p: { claimId: number; integracaoId: string }) => (
    <div data-testid="painel-ml">{JSON.stringify(p)}</div>
  ),
}));
vi.mock('../ReclamacaoShopeePanel', () => ({
  ReclamacaoShopeePanel: (p: { integracaoId: string; pedidoId: string; returnSn: string }) => (
    <div data-testid="painel-shopee">{JSON.stringify(p)}</div>
  ),
}));

function withResolucaoFrete(estado: EstadoFrete): NonNullable<Incidente['resolucao']> {
  return {
    data: null,
    valor: 0,
    tipo: 0,
    comentarios: null,
    frete: { estado } as NonNullable<NonNullable<Incidente['resolucao']>['frete']>,
  };
}

function incidente(overrides: Partial<Incidente> = {}): Incidente {
  return {
    origem: null,
    tipo: TIPO_INCIDENTE.devolucao,
    motivoDoIncidente: 'Motivo original',
    comentarios: 'Comentário original',
    timestamp: null,
    ultimaModificacao: null,
    externalId: null,
    resolucao: null,
    ...overrides,
  } as Incidente;
}

function renderTabWithIncidente(inc: Incidente) {
  snapState.current = { data: [{ id: 'inc-1', data: inc }], loading: false, error: undefined };
  render(
    <MantineTestProvider>
      <IncidentesTab pedidoId="ped-1" />
    </MantineTestProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
}

describe('IncidentesTab — incidente-level fields honour the resolução lock (#374)', () => {
  it('leaves Tipo/Motivo/Comentários editable when there is no resolução', () => {
    renderTabWithIncidente(incidente());

    // Mantine's Select keeps its (closed) options listbox in the DOM with
    // `aria-labelledby` pointing at the same label, so `getByLabelText`
    // matches both it and the input — `getByRole('combobox', …)` targets the
    // input alone.
    // This suite loads no jest-dom, so `.toHaveProperty('disabled', …)` rather
    // than `toBeDisabled` (matches the rest of the codebase's convention).
    expect(screen.getByRole('combobox', { name: 'Tipo' })).toHaveProperty('disabled', false);
    expect(screen.getByLabelText('Motivo')).toHaveProperty('disabled', false);
    expect(screen.getByLabelText('Comentários')).toHaveProperty('disabled', false);
  });

  it('leaves them editable while the resolução frete is still `iniciado`', () => {
    renderTabWithIncidente(incidente({ resolucao: withResolucaoFrete(ESTADO_FRETE.iniciado) }));

    expect(screen.getByRole('combobox', { name: 'Tipo' })).toHaveProperty('disabled', false);
    expect(screen.getByLabelText('Motivo')).toHaveProperty('disabled', false);
    expect(screen.getByLabelText('Comentários')).toHaveProperty('disabled', false);
  });

  it('locks Tipo/Motivo/Comentários once the resolução frete has advanced past `iniciado`', () => {
    renderTabWithIncidente(incidente({ resolucao: withResolucaoFrete(ESTADO_FRETE.postado) }));

    expect(screen.getByRole('combobox', { name: 'Tipo' })).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Motivo')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Comentários')).toHaveProperty('disabled', true);
    // Origem is out of scope for the `bloquear` lock (no field in the legacy
    // widget either) — it must stay editable.
    expect(screen.getByRole('combobox', { name: 'Origem' })).toHaveProperty('disabled', false);
  });
});

/* -------------------------------------------------------------------------- */
/*        #1250 — the lock and the save read the LIVE row, not a capture      */
/* -------------------------------------------------------------------------- */

// The editor used to freeze the incidente at `openEdit` and never re-sync it,
// so a document another writer advanced while the form was open stayed
// invisible: the resolução lock never armed, and the save wrote the frozen copy
// back as a whole-document `set` — regressing `resolucao`, `claimStatus`,
// `claimStage` and `entregue`, which the Mercado Livre claims webhook owns.

const { saveIncidenteEdit } = await import('@/lib/pedidos/saveIncidenteEdit');
const saveEditMock = vi.mocked(saveIncidenteEdit);
const { deleteIncidente, saveIncidente } = await import('@delfrance/data/pedido');
const saveIncidenteMock = vi.mocked(saveIncidente);
const deleteIncidenteMock = vi.mocked(deleteIncidente);

const flushRef: { current: IncidenteFlush | null } = { current: null };

// A FRESH element per render: React bails out of a re-render when handed the
// referentially identical element, so a module-level constant would make
// `rerender` a no-op and every "the snapshot changed" assertion vacuous.
const tab = () => (
  <MantineTestProvider>
    <IncidentesTab pedidoId="ped-1" flushRef={flushRef} />
  </MantineTestProvider>
);

async function flushIncidentes(): Promise<boolean> {
  let flushed = false;
  await act(async () => {
    flushed = (await flushRef.current?.()) ?? false;
  });
  return flushed;
}

function snapshotOf(inc: Incidente) {
  return { data: [{ id: 'inc-1', data: inc }], loading: false, error: undefined };
}

/** Render, open the editor, and hand back a way to push a new snapshot in. */
function openEditor(inc: Incidente) {
  snapState.current = snapshotOf(inc);
  const { rerender } = render(tab());
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
  return {
    /** Push a live snapshot update, as `onSnapshot` would. */
    push(next: Incidente | null) {
      snapState.current =
        next === null ? { data: [], loading: false, error: undefined } : snapshotOf(next);
      rerender(tab());
    },
  };
}

const motivoInput = () => screen.getByLabelText('Motivo') as HTMLTextAreaElement;

beforeEach(() => {
  flushRef.current = null;
  saveEditMock.mockReset();
  saveEditMock.mockResolvedValue({});
  saveIncidenteMock.mockReset();
  saveIncidenteMock.mockResolvedValue(undefined);
  deleteIncidenteMock.mockReset();
  deleteIncidenteMock.mockResolvedValue(undefined);
});

describe('IncidentesTab — the resolução lock re-arms from live data (#1250)', () => {
  it('locks the fields when the frete advances while the form is open', () => {
    const { push } = openEditor(
      incidente({ resolucao: withResolucaoFrete(ESTADO_FRETE.iniciado) }),
    );
    fireEvent.change(motivoInput(), { target: { value: 'Motivo digitado' } });
    expect(screen.getByLabelText('Motivo')).toHaveProperty('disabled', false);

    push(incidente({ resolucao: withResolucaoFrete(ESTADO_FRETE.postado) }));

    expect(screen.getByRole('combobox', { name: 'Tipo' })).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Motivo')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Comentários')).toHaveProperty('disabled', true);
    expect(screen.getByText('Bloqueada — frete em andamento')).toBeDefined();
    // Nothing vanishes under the operator: the text they typed is still there.
    expect(motivoInput().value).toBe('Motivo digitado');
  });

  it('saves against the version the operator reviewed, not the frozen capture', async () => {
    const baseline = incidente({ resolucao: withResolucaoFrete(ESTADO_FRETE.iniciado) });
    const { push } = openEditor(baseline);
    fireEvent.change(motivoInput(), { target: { value: 'Motivo digitado' } });
    push(incidente({ resolucao: withResolucaoFrete(ESTADO_FRETE.postado) }));

    expect(await flushIncidentes()).toBe(true);
    await screen.findByRole('button', { name: 'Editar' });

    // The guarded path, never the whole-document `set`.
    expect(saveIncidenteMock).not.toHaveBeenCalled();
    expect(saveEditMock).toHaveBeenCalledTimes(1);
    expect(saveEditMock.mock.calls[0]?.[1]?.baseline).toEqual(baseline);
  });

  it('shows the conflict modal instead of overwriting, then re-baselines on force-save', async () => {
    const baseline = incidente();
    const remoto = incidente({ motivoDoIncidente: 'Escrito por outra pessoa' });
    openEditor(baseline);
    fireEvent.change(motivoInput(), { target: { value: 'Motivo digitado' } });

    saveEditMock.mockRejectedValueOnce(
      new IncidenteConflictError(remoto, ['motivoDoIncidente'], false),
    );
    expect(await flushIncidentes()).toBe(false);

    expect(await screen.findByText('Incidente alterado')).toBeDefined();
    // Both sides of the diff, under the schema's own `.describe()` label.
    // Scoped to the dialog: the incidente card behind it shows the same motivo.
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Motivo')).toBeDefined();
    expect(dialog.getByText('Motivo original')).toBeDefined();
    expect(dialog.getByText('Escrito por outra pessoa')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    await screen.findByRole('button', { name: 'Editar' });

    // Re-baselined on the version just reviewed, not a blind force-write.
    expect(saveEditMock).toHaveBeenCalledTimes(2);
    expect(saveEditMock.mock.calls[1]?.[1]?.baseline).toBe(remoto);
  });

  it('names the frete lock in the modal when it armed while the form was open', async () => {
    openEditor(incidente({ resolucao: withResolucaoFrete(ESTADO_FRETE.iniciado) }));
    fireEvent.change(motivoInput(), { target: { value: 'Motivo digitado' } });
    saveEditMock.mockRejectedValueOnce(
      new IncidenteConflictError(
        incidente({ resolucao: withResolucaoFrete(ESTADO_FRETE.postado) }),
        ['resolucao'],
        true,
      ),
    );
    expect(await flushIncidentes()).toBe(false);

    expect(await screen.findByText(/frete da resolução avançou/i)).toBeDefined();
    // A resolução-only conflict must still SHOW something: rendering both sides
    // as "alterado" would be a diff with no information in it, at exactly the
    // moment the operator has to decide whether to override.
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/Item devolvido .* frete Iniciado/)).toBeDefined();
    expect(dialog.getByText(/Item devolvido .* frete Postado/)).toBeDefined();
  });

  it('refuses to re-create an incidente deleted under the open form', async () => {
    const { push } = openEditor(incidente());
    fireEvent.change(motivoInput(), { target: { value: 'Motivo digitado' } });
    push(null);

    expect(
      screen.getByText(/foi excluído por outra pessoa enquanto você o editava/i),
    ).toBeDefined();
    expect(await flushIncidentes()).toBe(false);
    expect(screen.getByText(new IncidenteMissingError().message)).toBeDefined();
    expect(saveEditMock).not.toHaveBeenCalled();
    expect(new IncidenteMissingError().name).toBe('IncidenteMissingError');
  });

  it('keeps the draft open when Firestore rejects the shared flush', async () => {
    openEditor(incidente());
    fireEvent.change(motivoInput(), { target: { value: 'Motivo pendente' } });
    saveEditMock.mockRejectedValueOnce(new FirebaseError('permission-denied', 'Sem permissão'));

    expect(await flushIncidentes()).toBe(false);

    expect(screen.getByText('Sem permissão')).toBeDefined();
    expect(motivoInput().value).toBe('Motivo pendente');
    expect(screen.getByText('Alterações não salvas')).toBeDefined();
  });

  it('still creates through the whole-document set — nothing stored to regress', async () => {
    snapState.current = snapshotOf(incidente());
    render(tab());
    fireEvent.click(screen.getByRole('button', { name: 'Novo incidente' }));
    fireEvent.change(motivoInput(), { target: { value: 'Novo motivo' } });
    expect(await flushIncidentes()).toBe(true);
    await screen.findByRole('button', { name: 'Novo incidente' });

    expect(saveIncidenteMock).toHaveBeenCalledTimes(1);
    expect(saveIncidenteMock.mock.calls[0]?.[1]?.incidenteId).toBeNull();
    expect(saveEditMock).not.toHaveBeenCalled();
  });

  it('treats an untouched create card as pending and persists its valid defaults', async () => {
    snapState.current = { data: [], loading: false, error: undefined };
    render(tab());

    fireEvent.click(screen.getByRole('button', { name: 'Novo incidente' }));

    expect(screen.getByText('Alterações não salvas')).toBeDefined();
    expect(await flushIncidentes()).toBe(true);
    expect(saveIncidenteMock).toHaveBeenCalledTimes(1);
    expect(saveIncidenteMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        pedidoId: 'ped-1',
        incidenteId: null,
        incidente: expect.objectContaining({ tipo: TIPO_INCIDENTE.devolucao }),
      }),
    );
  });

  it('stages a deletion, supports undo and only deletes during the shared flush', async () => {
    snapState.current = snapshotOf(incidente());
    render(tab());

    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    expect(screen.getByText('Será excluído')).toBeDefined();
    expect(deleteIncidenteMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }));
    expect(screen.queryByText('Será excluído')).toBeNull();
    expect(await flushIncidentes()).toBe(true);
    expect(deleteIncidenteMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    expect(await flushIncidentes()).toBe(true);
    expect(deleteIncidenteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pedidoId: 'ped-1', incidenteId: 'inc-1' }),
    );
  });

  it('does not submit the outer pedido form from inline actions', () => {
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    snapState.current = snapshotOf(incidente());
    render(
      <MantineTestProvider>
        <form onSubmit={onSubmit}>
          <IncidentesTab pedidoId="ped-1" flushRef={flushRef} />
        </form>
      </MantineTestProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }));

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*     #1525 — which channel panel mounts, and the lock on imported rows      */
/* -------------------------------------------------------------------------- */

// ⚠️ The ALPHANUMERIC fixture return_sn on purpose: every Shopee sample is
// alphanumeric, and a digits-only id would hide the one shape ML's
// safe-integer test breaks.
const RETURN_SN = '260910ABCDE0001';

const linhaShopee = (over: Partial<Incidente> = {}) =>
  incidente({
    origem: ORIGEM_INCIDENTE.pedidoShopee,
    tipo: TIPO_INCIDENTE.devolucao,
    externalId: RETURN_SN,
    ...over,
  });
// `mediations`, NOT the form's default `returns`, so "the tipo was kept" cannot
// pass by coincidence.
const linhaMl = (over: Partial<Incidente> = {}) =>
  incidente({
    origem: ORIGEM_INCIDENTE.pedidoMercadoLivre,
    tipo: TIPO_INCIDENTE.mediacaoDoMarketplace,
    externalId: '5123456789',
    ...over,
  });

function renderRows(
  rows: Incidente[],
  props: { integracaoId?: string | null; disabled?: boolean } = { integracaoId: 'int-1' },
) {
  snapState.current = {
    data: rows.map((data, i) => ({ id: `inc-${String(i + 1)}`, data })),
    loading: false,
    error: undefined,
  };
  return render(
    <MantineTestProvider>
      <IncidentesTab pedidoId="ped-1" flushRef={flushRef} {...props} />
    </MantineTestProvider>,
  );
}

const paineisShopee = () =>
  screen
    .queryAllByTestId('painel-shopee')
    .map((el) => JSON.parse(el.textContent ?? '') as Record<string, unknown>);
const paineisMl = () => screen.queryAllByTestId('painel-ml');

/** The options the Origem dropdown offers, read from the open listbox. */
function opcoesDaOrigem(): string[] {
  fireEvent.click(screen.getByRole('combobox', { name: 'Origem' }));
  const listbox = screen.getByRole('listbox', { name: 'Origem' });
  return within(listbox)
    .getAllByRole('option', { hidden: true })
    .map((o) => o.textContent ?? '');
}

describe('IncidentesTab — the Shopee return panel (#1525)', () => {
  it('mounts the Shopee panel on a Shopee row, with the conta, the pedido and the return_sn', () => {
    // Padded on purpose: the panel and the label get the TRIMMED id — the one
    // the shared predicate accepted — never the stored text verbatim.
    renderRows([linhaShopee({ externalId: ` ${RETURN_SN} ` })]);

    expect(paineisShopee()).toEqual([
      { integracaoId: 'int-1', pedidoId: 'ped-1', returnSn: RETURN_SN },
    ]);
    expect(paineisMl()).toHaveLength(0);
    expect(screen.getByText(`Shopee #${RETURN_SN}`)).toBeDefined();
  });

  it('keeps an ML claim on the ML panel — an all-digit id is a valid return_sn too', () => {
    // ⚠️ The near-miss for "mount on externalId alone": ML's claim id passes the
    // return_sn shape, so only the ORIGEM half keeps the Shopee panel off it.
    renderRows([linhaMl()]);

    expect(paineisMl()).toHaveLength(1);
    expect(paineisShopee()).toEqual([]);
    expect(screen.getByText('ML #5123456789')).toBeDefined();
    expect(screen.queryByText(/Shopee #/)).toBeNull();
  });

  it('mounts one panel per return, each on its own return_sn', () => {
    renderRows([linhaShopee(), linhaShopee({ externalId: '2609100000000002' })]);
    expect(paineisShopee().map((p) => p.returnSn)).toEqual([RETURN_SN, '2609100000000002']);
  });

  it('mounts nothing on a manual row, nor on a Shopee row whose id is not a return_sn', () => {
    renderRows([
      incidente({ origem: ORIGEM_INCIDENTE.outros, externalId: RETURN_SN }),
      linhaShopee({ externalId: '2609-ABC' }),
    ]);

    expect(paineisShopee()).toEqual([]);
    expect(paineisMl()).toHaveLength(0);
    expect(screen.queryByText(/Shopee #/)).toBeNull();
    expect(screen.getByText(`Ref. externa: ${RETURN_SN}`)).toBeDefined();
    expect(screen.getByText('Ref. externa: 2609-ABC')).toBeDefined();
  });

  it('labels the return but mounts no panel when the pedido has no conta', () => {
    renderRows([linhaShopee()], { integracaoId: null });
    expect(paineisShopee()).toEqual([]);
    expect(screen.getByText(`Shopee #${RETURN_SN}`)).toBeDefined();
  });

  it('still mounts the panel on a read-only pedido — its actions act on the channel', () => {
    // ⚠️ A finalised or locked pedido is exactly when a return still needs an
    // answer; gating the panel on the form's `disabled` would hide it then.
    renderRows([linhaShopee()], { integracaoId: 'int-1', disabled: true });
    expect(paineisShopee()).toHaveLength(1);
  });

  it('unmounts the panel of a row staged for deletion', () => {
    renderRows([linhaShopee()]);
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    expect(paineisShopee()).toEqual([]);
  });
});

describe('IncidentesTab — origem and tipo of an imported row are the importer’s (#1525)', () => {
  it.each([
    ['Shopee', linhaShopee, 'Pedido Shopee', 'Devolução'],
    ['Mercado Livre', linhaMl, 'Pedido Mercado Livre', 'Mediação do Marketplace'],
  ] as const)(
    'an imported %s row: Tipo and Origem locked, showing the stored values',
    (_canal, linha, origemLabel, tipoLabel) => {
      renderRows([linha()]);
      fireEvent.click(screen.getByRole('button', { name: 'Editar' }));

      const tipo = screen.getByRole('combobox', { name: 'Tipo' }) as HTMLInputElement;
      const origem = screen.getByRole('combobox', { name: 'Origem' }) as HTMLInputElement;
      expect(tipo.disabled).toBe(true);
      expect(origem.disabled).toBe(true);
      // The row's own origem stays an option, so the locked field still SHOWS it.
      expect(origem.value).toBe(origemLabel);
      expect(tipo.value).toBe(tipoLabel);
      expect(screen.getByText('Definida pela importação do canal')).toBeDefined();
      // The operator's own fields stay theirs.
      expect(screen.getByLabelText('Motivo')).toHaveProperty('disabled', false);
    },
  );

  it.each([
    ['Shopee', linhaShopee],
    ['Mercado Livre', linhaMl],
  ] as const)(
    'editing an imported %s row saves, and keeps its origem and tipo',
    async (_canal, linha) => {
      // ⚠️ The validator refuses a marketplace origem unless the STORED row
      // already holds it. Called without that row, it applies the create rule
      // and every edit of an imported row fails with ORIGEM_EXCLUSIVA_MSG.
      const stored = linha();
      renderRows([stored]);
      fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
      fireEvent.change(motivoInput(), { target: { value: 'Anotação do operador' } });

      expect(await flushIncidentes()).toBe(true);

      expect(screen.queryByText(ORIGEM_EXCLUSIVA_MSG)).toBeNull();
      expect(saveEditMock).toHaveBeenCalledTimes(1);
      const { form, baseline } = saveEditMock.mock.calls[0]![1];
      expect(baseline).toEqual(stored);
      expect(form.origem).toBe(String(stored.origem));
      expect(form.tipo).toBe(stored.tipo);
      expect(form.motivo).toBe('Anotação do operador');
    },
  );

  it('offers no marketplace origem on a manual row', () => {
    renderRows([incidente()]);
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));

    expect((screen.getByRole('combobox', { name: 'Origem' }) as HTMLInputElement).disabled).toBe(
      false,
    );
    const opcoes = opcoesDaOrigem();
    expect(opcoes).toContain('Site');
    expect(opcoes).toContain('Outros');
    expect(opcoes).not.toContain('Pedido Shopee');
    expect(opcoes).not.toContain('Pedido Mercado Livre');
  });

  it('offers no marketplace origem on a new incidente either', () => {
    renderRows([]);
    fireEvent.click(screen.getByRole('button', { name: 'Novo incidente' }));

    const opcoes = opcoesDaOrigem();
    expect(opcoes).toContain('(nenhuma)');
    expect(opcoes).not.toContain('Pedido Shopee');
    expect(opcoes).not.toContain('Pedido Mercado Livre');
  });

  it('keeps a legacy row’s own marketplace origem editable when it carries no id', () => {
    // A row tagged Mercado Livre by a person (no externalId) is not imported:
    // it stays editable and keeps its displayable value — but Shopee is still
    // not offered, since only an importer writes that one.
    renderRows([incidente({ origem: ORIGEM_INCIDENTE.pedidoMercadoLivre })]);
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));

    const origem = screen.getByRole('combobox', { name: 'Origem' }) as HTMLInputElement;
    expect(origem.disabled).toBe(false);
    expect(origem.value).toBe('Pedido Mercado Livre');
    const opcoes = opcoesDaOrigem();
    expect(opcoes).toContain('Pedido Mercado Livre');
    expect(opcoes).not.toContain('Pedido Shopee');
  });
});
