import { describe, expect, it } from 'vitest';
import {
  type ClienteRow,
  clienteOuterRefFor,
  indexarClientesPorUsuario,
  planConversaClienteRef,
} from './transform';

/** Shorthand: build the index from `[clienteId, userCliente]` pairs. */
const idx = (...pares: Array<[string, unknown]>) =>
  indexarClientesPorUsuario(pares.map(([id, userCliente]): ClienteRow => ({ id, userCliente })));

const VAZIO = indexarClientesPorUsuario([]);

describe('indexarClientesPorUsuario', () => {
  it('indexes BOTH stored shapes under the same uid', () => {
    // ⚠️ The single most important property. `usuarioOuterRef()` writes the
    // `documents/`-prefixed form; the legacy corpus carries the bare one. A
    // single-shape index silently misses half the population, and the failure
    // mode is a conversa that looks unmappable when it is not.
    const m = idx(['c1', 'documents/usuarios/u1'], ['c2', 'usuarios/u2']);
    expect(m.get('u1')).toEqual(['c1']);
    expect(m.get('u2')).toEqual(['c2']);
  });

  it('collects every claimant rather than collapsing them', () => {
    // Collapsing to one id here would destroy the signal `ambiguo` reports.
    const m = idx(['c2', 'documents/usuarios/u1'], ['c1', 'usuarios/u1']);
    expect(m.get('u1')).toEqual(['c1', 'c2']);
  });

  it('sorts claimants so a report is stable across runs', () => {
    const m = idx(['cZ', 'usuarios/u1'], ['cA', 'usuarios/u1'], ['cM', 'usuarios/u1']);
    expect(m.get('u1')).toEqual(['cA', 'cM', 'cZ']);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['a non-string', 42],
    ['a ref to another collection', 'documents/clientes/c9'],
    ['a bare ref to another collection', 'pedidos/p1'],
    ['a ref with no id', 'documents/usuarios/'],
  ])('ignores a userCliente that is %s', (_label, valor) => {
    expect(indexarClientesPorUsuario([{ id: 'c1', userCliente: valor }]).size).toBe(0);
  });
});

describe('planConversaClienteRef', () => {
  it('maps a conversa to the single cliente claiming its usuario', () => {
    const v = planConversaClienteRef(
      { clienteOuterRef: null, usarioOuterRef: 'documents/usuarios/u1' },
      idx(['c1', 'documents/usuarios/u1']),
    );
    expect(v).toEqual({
      kind: 'resolvido',
      de: 'documents/usuarios/u1',
      para: 'documents/clientes/c1',
      clienteId: 'c1',
    });
  });

  it('maps a conversa whose OWN usarioOuterRef is stored bare', () => {
    // Both sides of the join can be in either shape, independently.
    const v = planConversaClienteRef(
      { clienteOuterRef: null, usarioOuterRef: 'usuarios/u1' },
      idx(['c1', 'documents/usuarios/u1']),
    );
    expect(v).toMatchObject({ kind: 'resolvido', clienteId: 'c1' });
  });

  it('preserves a cliente id containing hyphens, dots and underscores', () => {
    const id = 'cli-2026.01_A';
    const v = planConversaClienteRef(
      { clienteOuterRef: null, usarioOuterRef: 'usuarios/u1' },
      idx([id, 'usuarios/u1']),
    );
    expect(v).toMatchObject({ para: clienteOuterRefFor(id) });
  });

  describe('idempotence', () => {
    it('never rewrites a conversa that already carries the field', () => {
      // ⚠️ This check comes FIRST, before the usuario hop. A doc written by a
      // current ML importer or by the WhatsApp pipeline already has the right
      // value; re-deriving it could only disagree, and disagreeing with a live
      // writer is how a backfill becomes a regression.
      const v = planConversaClienteRef(
        {
          clienteOuterRef: 'documents/clientes/JA-CERTO',
          usarioOuterRef: 'documents/usuarios/u1',
        },
        idx(['OUTRO', 'documents/usuarios/u1']),
      );
      expect(v).toEqual({ kind: 'ja-normalizado' });
    });

    it('a second pass over already-migrated data changes nothing', () => {
      const indice = idx(['c1', 'usuarios/u1']);
      const primeira = planConversaClienteRef(
        { clienteOuterRef: null, usarioOuterRef: 'usuarios/u1' },
        indice,
      );
      expect(primeira.kind).toBe('resolvido');
      // Feed the first pass's own output back in — this is the shape of the
      // verification run, so it must report nothing to do.
      const segunda = planConversaClienteRef(
        {
          clienteOuterRef: (primeira as { para: string }).para,
          usarioOuterRef: 'usuarios/u1',
        },
        indice,
      );
      expect(segunda).toEqual({ kind: 'ja-normalizado' });
    });
  });

  describe('reports rather than guesses', () => {
    it('refuses when NO cliente claims the usuario', () => {
      // Building a ref from the uid would aim the filter at a `clientes` doc
      // that does not exist — worse than the absent field the UI handles.
      expect(
        planConversaClienteRef(
          { clienteOuterRef: null, usarioOuterRef: 'documents/usuarios/orfao' },
          VAZIO,
        ),
      ).toEqual({ kind: 'sem-cliente', usuarioId: 'orfao' });
    });

    it('refuses when TWO clientes claim the usuario, naming both', () => {
      // Duplicated identity is the defect #1067 exists to prevent. Picking the
      // lower doc id would hide it behind a coin flip.
      expect(
        planConversaClienteRef(
          { clienteOuterRef: null, usarioOuterRef: 'usuarios/u1' },
          idx(['c2', 'usuarios/u1'], ['c1', 'documents/usuarios/u1']),
        ),
      ).toEqual({ kind: 'ambiguo', usuarioId: 'u1', clienteIds: ['c1', 'c2'] });
    });

    it.each([
      ['a non-string', 42],
      ['a ref to another collection', 'documents/clientes/c1'],
      ['a bare ref to another collection', 'pedidos/p1'],
      ['a ref with no id', 'documents/usuarios/'],
    ])('refuses a usarioOuterRef that is %s', (_label, valor) => {
      const v = planConversaClienteRef({ clienteOuterRef: null, usarioOuterRef: valor }, VAZIO);
      expect(v.kind).toBe('ref-invalida');
    });

    it('names the offending collection in the reason, for the operator', () => {
      const v = planConversaClienteRef(
        { clienteOuterRef: null, usarioOuterRef: 'documents/pedidos/p1' },
        VAZIO,
      );
      expect(v).toMatchObject({ kind: 'ref-invalida', motivo: expect.stringContaining('pedidos') });
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('treats a conversa with %s usarioOuterRef as nothing to map', (_label, valor) => {
    expect(planConversaClienteRef({ clienteOuterRef: null, usarioOuterRef: valor }, VAZIO)).toEqual(
      { kind: 'sem-usuario' },
    );
  });

  it('an empty-string clienteOuterRef is NOT "already normalized"', () => {
    // A stored `''` is absence, not a value — treating it as set would skip a
    // conversa that genuinely needs the backfill.
    expect(
      planConversaClienteRef(
        { clienteOuterRef: '', usarioOuterRef: 'usuarios/u1' },
        idx(['c1', 'usuarios/u1']),
      ),
    ).toMatchObject({ kind: 'resolvido', clienteId: 'c1' });
  });
});
