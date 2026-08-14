import { describe, expect, it } from 'vitest';
import { ESTADO_PEDIDO, type HistoricoEstadoPedido } from '@delfrance/schemas';

import { legacyEstadoEntries } from './ModificacoesTab';

function row(id: string, data: Partial<HistoricoEstadoPedido> = {}) {
  return {
    id,
    data: {
      estado: ESTADO_PEDIDO.pago,
      usuarioHistoricoEstadosPedidoOuterRef: null,
      data: 1_700_000_000_000_000,
      eventId: null,
      ...data,
    } as HistoricoEstadoPedido,
  };
}

describe('legacyEstadoEntries', () => {
  it('takes rows with NO eventId — the ones the modification history cannot cover', () => {
    const entries = legacyEstadoEntries([row('a', { eventId: null })], 'ped1');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.campos).toEqual(['estado']);
  });

  it('DROPS rows the trigger wrote, so a post-deploy transition is not shown twice', () => {
    // Since the modification trigger shipped, an estado change is recorded as an
    // ordinary field of the pedido document. Both rows are keyed on the same
    // CloudEvent, so replaying the whole trail would duplicate every one of
    // them. A non-null eventId is exactly the "already covered" marker.
    const entries = legacyEstadoEntries(
      [row('a', { eventId: 'evt-1' }), row('b', { eventId: null })],
      'ped1',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toContain('b');
  });

  it('renders the estado LABEL, and never invents a previous value', () => {
    // The legacy row stored only the new state, so `old` must stay null rather
    // than guessing what preceded it.
    const [entry] = legacyEstadoEntries([row('a', { estado: ESTADO_PEDIDO.pago })], 'ped1');
    expect(entry?.changes.estado).toEqual({ old: null, new: 'Pago' });
  });

  it('carries the actor the legacy trail DID record, under the feed field name', () => {
    const ref = 'documents/usuarios/AbCdEf0123456789AbCdEf01';
    const [entry] = legacyEstadoEntries(
      [row('a', { usuarioHistoricoEstadosPedidoOuterRef: ref })],
      'ped1',
    );
    expect(entry?.usuarioOuterRef).toBe(ref);
  });

  it('namespaces its ids so they cannot collide with a real history row', () => {
    const [entry] = legacyEstadoEntries([row('evt-x')], 'ped1');
    expect(entry?.id).toBe('estado-legado:evt-x');
  });

  it('keeps a missing data stamp as null rather than sorting it to the top', () => {
    const [entry] = legacyEstadoEntries([row('a', { data: null })], 'ped1');
    expect(entry?.timestamp).toBeNull();
  });
});
