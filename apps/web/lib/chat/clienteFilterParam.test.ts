import { describe, expect, it } from 'vitest';
import {
  TAB_DO_FILTRO_CLIENTE,
  aplicarFiltroCliente,
  aplicarTab,
  ehTabPermitida,
  limparClienteAoFiltrar,
  parseClienteParam,
  resolverFiltroCliente,
} from './clienteFilterParam';
import { CONVERSA_TABS } from './conversaConstraints';

const CLIENTE = 'documents/clientes/c1';

describe('parseClienteParam', () => {
  it('accepts the canonical form unchanged', () => {
    expect(parseClienteParam('documents/clientes/c1')).toBe('documents/clientes/c1');
  });

  it('CANONICALIZES a bare `clientes/<id>` rather than passing it through', () => {
    // ⚠️ `conversa.clienteOuterRef` is `outerRefSchema`,
    // `/^documents(\/[^/]+\/[^/]+)+$/` — the bare form is not even storable, and
    // a Firestore `==` cannot normalize the way `parseSoftRead`/`toOuterRef` do.
    // Passing it through would build a query matching nothing: the silent
    // empty-inbox this whole function exists to prevent.
    expect(parseClienteParam('clientes/c1')).toBe('documents/clientes/c1');
  });

  describe('drops a value that cannot match', () => {
    it('⚠️ a STALE pre-#1159 usuarios ref', () => {
      // Those URLs are bookmarked, pasted into chats and sitting in history.
      // Querying one returns an empty inbox that looks exactly like the bug this
      // change fixes, so it must read as "no filter" instead.
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

describe('the cliente/query invariant', () => {
  // ⚠️ A correctness property with a BILLING consequence, not a UX preference.
  // Every exclusive param adds a clause to the same query, so each pairing is a
  // composite needing its own index — and on Firestore Enterprise an unindexed
  // query does not throw, it silently full-scans and bills, on a live
  // `onSnapshot`. The combinations multiply (2 filters × 5 orderings = 20
  // shapes), which is why the pairing is made impossible instead of indexed.

  it('only `todas` is permitted, and it is the tab a pick moves to', () => {
    expect(TAB_DO_FILTRO_CLIENTE).toBe('todas');
    // Enumerate the real tab list, so a NEW tab cannot be added silently.
    for (const tab of CONVERSA_TABS) {
      expect(ehTabPermitida(tab)).toBe(tab === 'todas');
    }
  });

  it('picking a cliente clears the tab, the ordering, the etiqueta AND the integração', () => {
    const p = new URLSearchParams('tab=pendentes&ordem=prazo_desc&etiqueta=16711680&integracao=i1');
    aplicarFiltroCliente(p, CLIENTE);
    expect(p.get('cliente')).toBe(CLIENTE);
    expect(p.get('tab')).toBe('todas');
    // Each of these would otherwise stack into a composite with no index.
    expect(p.get('ordem')).toBeNull();
    expect(p.get('etiqueta')).toBeNull();
    expect(p.get('integracao')).toBeNull();
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

  it('setting any exclusive filter clears the cliente', () => {
    const p = new URLSearchParams(`tab=todas&cliente=${CLIENTE}`);
    limparClienteAoFiltrar(p);
    expect(p.get('cliente')).toBeNull();
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

describe('resolverFiltroCliente — the invariant holds on READ too', () => {
  // ⚠️ Enforcing it only on write would leave the property conventional rather
  // than total: every param is deep-linkable by design, so a bookmarked, shared
  // or hand-edited URL must not be able to build a query no index covers.

  it('resolves the ref when the URL is clean', () => {
    const p = new URLSearchParams(`cliente=${CLIENTE}`);
    expect(resolverFiltroCliente(p, 'todas')).toBe(CLIENTE);
  });

  it('canonicalizes on the way out', () => {
    const p = new URLSearchParams('cliente=clientes/c1');
    expect(resolverFiltroCliente(p, 'todas')).toBe(CLIENTE);
  });

  it.each(CONVERSA_TABS.filter((t) => t !== 'todas'))(
    'refuses a hand-edited `?tab=%s&cliente=…`',
    (tab) => {
      const p = new URLSearchParams(`tab=${tab}&cliente=${CLIENTE}`);
      expect(resolverFiltroCliente(p, tab)).toBeNull();
    },
  );

  it.each([
    ['ordem', 'ordem=prazo_asc'],
    ['etiqueta', 'etiqueta=16711680'],
    ['integracao', 'integracao=i1'],
  ])('refuses a URL that also carries %s', (_label, extra) => {
    const p = new URLSearchParams(`cliente=${CLIENTE}&${extra}`);
    expect(resolverFiltroCliente(p, 'todas')).toBeNull();
  });

  it('ignores `busca` — search mode replaces the list, it does not stack', () => {
    // `GlobalSearchPane` takes over the pane entirely, so `busca` never adds a
    // clause to the conversa query and must not disable the cliente filter.
    const p = new URLSearchParams(`cliente=${CLIENTE}&busca=nota`);
    expect(resolverFiltroCliente(p, 'todas')).toBe(CLIENTE);
  });

  it('holds through any sequence of operations', () => {
    // Stated directly: after ANY operation, a resolvable cliente filter implies
    // a query of exactly `clienteOuterRef == X orderBy ultima_modificacao desc`.
    const p = new URLSearchParams();
    const ops: Array<() => void> = [
      () => aplicarTab(p, 'atendimento'),
      () => aplicarFiltroCliente(p, CLIENTE),
      () => aplicarTab(p, 'pendentes'),
      () => aplicarFiltroCliente(p, CLIENTE),
      () => limparClienteAoFiltrar(p),
      () => aplicarFiltroCliente(p, CLIENTE),
      () => aplicarTab(p, 'todas'),
      () => aplicarFiltroCliente(p, null),
      () => aplicarFiltroCliente(p, CLIENTE),
    ];
    let resolveuAlgumaVez = false;
    for (const op of ops) {
      op();
      const tab = (p.get('tab') ?? 'atendimento') as (typeof CONVERSA_TABS)[number];
      const ref = resolverFiltroCliente(p, tab);
      if (ref != null) {
        resolveuAlgumaVez = true;
        expect(tab).toBe('todas');
        expect(p.get('ordem')).toBeNull();
        expect(p.get('etiqueta')).toBeNull();
        expect(p.get('integracao')).toBeNull();
      }
    }
    // ...and the sequence really did exercise the filter, so the loop above was
    // not vacuously true.
    expect(resolveuAlgumaVez).toBe(true);
    expect(p.get('cliente')).toBe(CLIENTE);
  });
});
