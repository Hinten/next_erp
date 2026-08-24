import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { ESTADO_FRETE, type EstadoFrete, TIPO_INCIDENTE, type Incidente } from '@delfrance/schemas';
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
