import { describe, expect, it } from 'vitest';
import { CAMPO_HISTORICO_PRECO_CUSTO } from '@delfrance/schemas';

import { PEDIDO_HISTORY_ROOT, PRODUTO_HISTORY_ROOT } from './historyRoots';
import { buildModificationEntry, comRetencao, type ModificationEntry } from './modificationHistory';

// The TTL retention of `historicoDeModificacoes`, run against the REAL roots:
// what is stamped expires (Firestore TTL policy on the group), what is not
// stamped lives forever. Every "kept" case has a near-miss that IS stamped, so
// a predicate that keeps too much fails here too.

/** 2026-09-24T13:30:00.123456Z as µs — the sub-ms part must not leak into the expiry. */
const EVENT_MICROS = 1_790_256_600_123_456;

function entry(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): ModificationEntry {
  const built = buildModificationEntry({
    before,
    after,
    ignore: [],
    path: 'produtos/p1',
    subcolecao: null,
    docId: 'p1',
    eventId: 'evt1',
    eventTimeMicros: EVENT_MICROS,
    usuarioOuterRef: null,
  });
  if (built === null) throw new Error('fixture produced an empty diff');
  return built;
}

describe('produto history retention (365 days)', () => {
  const stamp = (e: ModificationEntry) => comRetencao(e, PRODUTO_HISTORY_ROOT.retencao);

  it('stamps an ordinary update 365 days after the EVENT, truncated to the ms', () => {
    const stamped = stamp(entry({ nome: 'A' }, { nome: 'B' }));
    expect(stamped.expiraEm?.toISOString()).toBe('2027-09-24T13:30:00.123Z');
  });

  it('stamps a create', () => {
    expect(stamp(entry(undefined, { nome: 'A' })).expiraEm).toBeInstanceOf(Date);
  });

  it('keeps a delete row forever (#648 restores from its snapshot)', () => {
    expect('expiraEm' in stamp(entry({ nome: 'A' }, undefined))).toBe(false);
  });

  it.each([CAMPO_HISTORICO_PRECO_CUSTO.preco, CAMPO_HISTORICO_PRECO_CUSTO.custo])(
    'keeps a row touching %s forever (the price/cost history button reads it)',
    (campo) => {
      const kept = stamp(entry({ [campo]: 1, nome: 'A' }, { [campo]: 2, nome: 'B' }));
      expect(kept.campos).toContain(campo);
      expect('expiraEm' in kept).toBe(false);
    },
  );

  // Near-miss: a field whose NAME merely resembles the kept ones is not kept.
  it('stamps a row touching only a look-alike field', () => {
    expect(stamp(entry({ precoMinimo: 1 }, { precoMinimo: 2 })).expiraEm).toBeInstanceOf(Date);
  });

  it('is deterministic, so a redelivered event rewrites an identical row', () => {
    const e = entry({ nome: 'A' }, { nome: 'B' });
    expect(stamp(e).expiraEm?.getTime()).toBe(stamp(e).expiraEm?.getTime());
  });

  it('leaves every other field of the entry untouched', () => {
    const e = entry({ nome: 'A' }, { nome: 'B' });
    const { expiraEm: _expiraEm, ...rest } = stamp(e);
    expect(rest).toEqual(e);
  });
});

describe('pedido history retention (6 years)', () => {
  const stamp = (e: ModificationEntry) => comRetencao(e, PEDIDO_HISTORY_ROOT.retencao);

  it('stamps an update 2190 days after the event', () => {
    const stamped = stamp(entry({ estado: 'a' }, { estado: 'b' }));
    expect(stamped.expiraEm?.toISOString()).toBe('2032-09-22T13:30:00.123Z');
  });

  it('keeps a delete row forever (the only record a deleted pedido existed)', () => {
    expect('expiraEm' in stamp(entry({ estado: 'a' }, undefined))).toBe(false);
  });

  // Near-miss: the produto price/cost exemption must NOT leak into pedidos.
  it('stamps a pedido row touching precos', () => {
    expect(stamp(entry({ precos: 1 }, { precos: 2 })).expiraEm).toBeInstanceOf(Date);
  });
});
