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
  it('maps EVERY row — deduping belongs to the feed, not to a filter here', () => {
    const entries = legacyEstadoEntries(
      [row('a', { eventId: 'evt-1' }), row('b', { eventId: null })],
      'ped1',
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]?.campos).toEqual(['estado']);
  });

  it('marks the history entry that would supersede each row, by CloudEvent id', () => {
    // The history entry's doc id IS the event id, so the feed can hide a row
    // exactly when its replacement is loaded. Filtering on `eventId != null`
    // here instead would ASSUME the replacement exists — and it does not for
    // transitions `onPedidoChanged` recorded before this PR's functions
    // deploy, which would then be dropped from the tab and never replaced.
    const entries = legacyEstadoEntries(
      [row('a', { eventId: 'evt-1' }), row('b', { eventId: null })],
      'ped1',
    );
    expect(entries[0]?.supersededByEntryId).toBe('evt-1');
    // No event id ⇒ nothing can supersede it; it always shows.
    expect(entries[1]?.supersededByEntryId).toBeNull();
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
