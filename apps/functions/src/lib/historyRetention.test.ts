import { describe, expect, it } from 'vitest';
import { CAMPO_HISTORICO_PRECO_CUSTO, expiraEmApos } from '@delfrance/schemas';

import { PEDIDO_HISTORY_ROOT, PRODUTO_HISTORY_ROOT } from './historyRoots';
import { buildModificationEntry, comRetencao, type ModificationEntry } from './modificationHistory';

// The TTL retention of `historicoDeModificacoes`, run against the REAL roots:
// what is stamped expires (Firestore TTL policy on the group), what is not
// stamped lives forever. Every "kept" case has a near-miss that IS stamped, so
// a predicate that keeps too much fails here too.

/** 2026-09-24T13:30:00.123456Z as µs — the sub-ms part rounds UP into the expiry. */
const EVENT_MICROS = 1_790_256_600_123_456;

function entry(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  eventTimeMicros = EVENT_MICROS,
): ModificationEntry {
  const built = buildModificationEntry({
    before,
    after,
    ignore: [],
    path: 'produtos/p1',
    subcolecao: null,
    docId: 'p1',
    eventId: 'evt1',
    eventTimeMicros,
    usuarioOuterRef: null,
  });
  if (built === null) throw new Error('fixture produced an empty diff');
  return built;
}

describe('produto history retention (365 days)', () => {
  const stamp = (e: ModificationEntry) => comRetencao(e, PRODUTO_HISTORY_ROOT.retencao);

  // Rounded UP (…123456 µs → …124 ms): a retention is a minimum, so the stamp
  // may be a fraction of a millisecond late but never early.
  it('stamps an ordinary update 365 days after the EVENT, rounded up to the ms', () => {
    const stamped = stamp(entry({ nome: 'A' }, { nome: 'B' }));
    expect(stamped.expiraEm?.toISOString()).toBe('2027-09-24T13:30:00.124Z');
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

describe('pedido history retention (6 calendar years)', () => {
  const stamp = (e: ModificationEntry) => comRetencao(e, PEDIDO_HISTORY_ROOT.retencao);

  it('stamps an update six calendar years after the event', () => {
    const stamped = stamp(entry({ estado: 'a' }, { estado: 'b' }));
    expect(stamped.expiraEm?.toISOString()).toBe('2032-09-24T13:30:00.124Z');
  });

  it('keeps a delete row forever (the only record a deleted pedido existed)', () => {
    expect('expiraEm' in stamp(entry({ estado: 'a' }, undefined))).toBe(false);
  });

  // Near-miss: the produto price/cost exemption must NOT leak into pedidos.
  it('stamps a pedido row touching precos', () => {
    expect(stamp(entry({ precos: 1 }, { precos: 2 })).expiraEm).toBeInstanceOf(Date);
  });
});

// The reason pedido rows live six years: the tax period (CTN art. 173, I) starts
// on January 1 of the Brazilian year AFTER the event and runs five years, so it
// closes at the start of that year + 6. This oracle computes the closing instant
// independently of the code under test — BRT is a fixed UTC-3 (no DST since
// 2019) — and every stamp must land at or after it.
describe('pedido retention vs the tax period it exists to cover', () => {
  const HORA_MS = 3_600_000;
  const fechamentoDoPrazo = (eventoMs: number) => {
    const anoBrt = new Date(eventoMs - 3 * HORA_MS).getUTCFullYear();
    return Date.UTC(anoBrt + 6, 0, 1, 3); // Jan 1, 00:00 BRT
  };
  const stampAt = (eventoMs: number) =>
    comRetencao(
      entry({ estado: 'a' }, { estado: 'b' }, eventoMs * 1000),
      PEDIDO_HISTORY_ROOT.retencao,
    ).expiraEm!.getTime();

  it.each([
    // The worst case: the very first instant of a Brazilian year gets the most
    // distant close. Six calendar years lands EXACTLY on it.
    ['the first instant of a Brazilian year', Date.UTC(2026, 0, 1, 3)],
    ['the last ms of a Brazilian year', Date.UTC(2027, 0, 1, 2, 59, 59, 999)],
    ['UTC midnight on Jan 1 (still Dec 31 in Brazil)', Date.UTC(2026, 0, 1)],
    ['a leap day', Date.UTC(2028, 1, 29, 12)],
    ['an ordinary mid-year event', Date.UTC(2026, 8, 24, 13, 30)],
  ])('never expires before the tax period closes — %s', (_label, eventoMs) => {
    expect(stampAt(eventoMs)).toBeGreaterThanOrEqual(fechamentoDoPrazo(eventoMs));
  });

  // The oracle has teeth: the 2190-day rule this replaced fails it.
  it('rejects the old 6 × 365-day rule at the start of a Brazilian year', () => {
    const eventoMs = Date.UTC(2026, 0, 1, 3);
    expect(expiraEmApos(eventoMs, 6 * 365).getTime()).toBeLessThan(fechamentoDoPrazo(eventoMs));
  });
});
