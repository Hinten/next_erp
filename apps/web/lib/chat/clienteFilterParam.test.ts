import { describe, expect, it } from 'vitest';
import {
  TAB_DO_FILTRO_CLIENTE,
  aplicarFiltroCliente,
  aplicarTab,
  ehTabPermitida,
  parseClienteParam,
} from './clienteFilterParam';
import { CONVERSA_TABS } from './conversaConstraints';

const CLIENTE = 'documents/clientes/c1';

describe('parseClienteParam', () => {
  it('accepts both stored ref shapes', () => {
    expect(parseClienteParam('documents/clientes/c1')).toBe('documents/clientes/c1');
    expect(parseClienteParam('clientes/c1')).toBe('clientes/c1');
  });

  describe('drops a value that cannot match', () => {
    it('⚠️ a STALE pre-#1159 usuarios ref', () => {
      // The case that matters: those URLs are bookmarked, pasted into chats and
      // sitting in history. Querying one returns an empty inbox that looks
      // exactly like the bug this whole change fixes, so it must read as
      // "no filter" rather than as "this customer has no threads".
      expect(parseClienteParam('documents/usuarios/u1')).toBeNull();
      expect(parseClienteParam('usuarios/u1')).toBeNull();
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['an empty string', ''],
      ['another collection', 'documents/pedidos/p1'],
      ['the prefix with no id', 'documents/clientes/'],
      ['the bare prefix with no id', 'clientes/'],
      ['a collection whose name merely starts the same', 'documents/clientesX/c1'],
    ])('%s', (_label, raw) => {
      expect(parseClienteParam(raw)).toBeNull();
    });
  });
});

describe('the cliente/tab invariant', () => {
  // ⚠️ This is a correctness property with a BILLING consequence, not a UX
  // preference. The cliente filter stacks on the tab's base clauses, so any
  // pairing other than `todas` is a composite with no index — and on Firestore
  // Enterprise an unindexed query does not throw, it silently full-scans and
  // bills the scan, on a live `onSnapshot`.

  it('only `todas` is permitted, and it is the tab a pick moves to', () => {
    expect(TAB_DO_FILTRO_CLIENTE).toBe('todas');
    // Enumerate the real tab list rather than a hand-written one, so a NEW tab
    // cannot be added without this failing.
    for (const tab of CONVERSA_TABS) {
      expect(ehTabPermitida(tab)).toBe(tab === 'todas');
    }
  });

  it('picking a cliente moves to todas and drops an explicit ordem', () => {
    const p = new URLSearchParams('tab=pendentes&ordem=prazo_desc');
    aplicarFiltroCliente(p, CLIENTE);
    expect(p.get('cliente')).toBe(CLIENTE);
    expect(p.get('tab')).toBe('todas');
    // `ultima_modificacao desc` is the ordering the single index covers; leaving
    // `prazo_desc` set would produce a composite nothing indexes.
    expect(p.get('ordem')).toBeNull();
  });

  it('leaving todas clears the cliente filter', () => {
    for (const tab of CONVERSA_TABS.filter((t) => t !== 'todas')) {
      const p = new URLSearchParams(`tab=todas&cliente=${CLIENTE}`);
      aplicarTab(p, tab);
      expect(p.get('cliente')).toBeNull();
    }
  });

  it('staying on todas KEEPS the cliente filter', () => {
    const p = new URLSearchParams(`tab=todas&cliente=${CLIENTE}`);
    aplicarTab(p, 'todas');
    expect(p.get('cliente')).toBe(CLIENTE);
  });

  it('holds through any sequence of tab changes and picks', () => {
    // The property, stated directly: after ANY operation, a cliente filter
    // implies the todas tab. A per-case test can miss an ordering; this cannot.
    const p = new URLSearchParams();
    const ops: Array<() => void> = [
      () => aplicarTab(p, 'atendimento'),
      () => aplicarFiltroCliente(p, CLIENTE),
      () => aplicarTab(p, 'pendentes'),
      () => aplicarFiltroCliente(p, CLIENTE),
      () => aplicarTab(p, 'todas'),
      () => aplicarFiltroCliente(p, null),
      () => aplicarTab(p, 'atendimento'),
      () => aplicarFiltroCliente(p, CLIENTE),
    ];
    for (const op of ops) {
      op();
      if (p.get('cliente') != null) {
        expect(p.get('tab')).toBe('todas');
      }
    }
    // ...and the sequence really did exercise the filter, so the loop above was
    // not vacuously true.
    expect(p.get('cliente')).toBe(CLIENTE);
  });

  it('clearing the filter leaves the tab alone', () => {
    const p = new URLSearchParams(`tab=todas&cliente=${CLIENTE}`);
    aplicarFiltroCliente(p, null);
    expect(p.get('cliente')).toBeNull();
    expect(p.get('tab')).toBe('todas');
  });

  it('represents the default tab by absence, as the URL scheme expects', () => {
    const p = new URLSearchParams('tab=todas');
    aplicarTab(p, 'atendimento');
    expect(p.get('tab')).toBeNull();
  });
});
