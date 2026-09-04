import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { ESTADO_FRETE, type EstadoFrete, TIPO_INCIDENTE, type Incidente } from '@delfrance/schemas';
import { IncidenteConflictError, IncidenteMissingError } from '@/lib/pedidos/saveIncidenteEdit';
import { IncidentesTab } from './IncidentesTab';

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
const { saveIncidente } = await import('@delfrance/data/pedido');
const saveIncidenteMock = vi.mocked(saveIncidente);

// A FRESH element per render: React bails out of a re-render when handed the
// referentially identical element, so a module-level constant would make
// `rerender` a no-op and every "the snapshot changed" assertion vacuous.
const tab = () => (
  <MantineTestProvider>
    <IncidentesTab pedidoId="ped-1" />
  </MantineTestProvider>
);

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
  saveEditMock.mockReset();
  saveEditMock.mockResolvedValue({});
  saveIncidenteMock.mockReset();
  saveIncidenteMock.mockResolvedValue(undefined);
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

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

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
    saveEditMock.mockRejectedValueOnce(
      new IncidenteConflictError(
        incidente({ resolucao: withResolucaoFrete(ESTADO_FRETE.postado) }),
        ['resolucao'],
        true,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

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
    expect(screen.getByRole('button', { name: 'Salvar' })).toHaveProperty('disabled', true);
    expect(saveEditMock).not.toHaveBeenCalled();
    expect(new IncidenteMissingError().name).toBe('IncidenteMissingError');
  });

  it('still creates through the whole-document set — nothing stored to regress', async () => {
    snapState.current = snapshotOf(incidente());
    render(tab());
    fireEvent.click(screen.getByRole('button', { name: '+ Adicionar incidente' }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await screen.findByRole('button', { name: '+ Adicionar incidente' });

    expect(saveIncidenteMock).toHaveBeenCalledTimes(1);
    expect(saveIncidenteMock.mock.calls[0]?.[1]?.incidenteId).toBeNull();
    expect(saveEditMock).not.toHaveBeenCalled();
  });
});
