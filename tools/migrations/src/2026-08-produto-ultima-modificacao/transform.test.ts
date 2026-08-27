import { describe, expect, it } from 'vitest';
import { planUltimaModificacao, SKIP_REASON } from './transform';

const FALLBACK = 1_700_000_000_000;

describe('planUltimaModificacao', () => {
  it('backfills a produto whose key is ABSENT, preferring its own timestamp', () => {
    expect(planUltimaModificacao({ nome: 'x', timestamp: 1_690_000_000_000 }, FALLBACK)).toEqual({
      action: 'change',
      from: null,
      to: 1_690_000_000_000,
    });
  });

  it('falls back to the migration clock when timestamp is unusable', () => {
    // Absent, null, and a legacy ISO string that never got normalized on disk.
    for (const timestamp of [undefined, null, '2026-01-01T00:00:00.000Z', Number.NaN]) {
      expect(planUltimaModificacao({ nome: 'x', timestamp }, FALLBACK)).toEqual({
        action: 'change',
        from: null,
        to: FALLBACK,
      });
    }
  });

  it('LEAVES A STORED null ALONE — it is already visible to orderBy', () => {
    // The bug is an ABSENT key, not a null one: Firestore indexes null and
    // sorts it last in DESC. Overwriting it would jump a produto the operator
    // never touched to the top of /produtos.
    expect(planUltimaModificacao({ nome: 'x', ultimaModificacao: null }, FALLBACK)).toEqual({
      action: 'skip',
      reason: SKIP_REASON.present,
      value: null,
    });
  });

  it('is IDEMPOTENT — re-running finds the key it just wrote and skips', () => {
    // What makes the script re-runnable, which matters because the legacy app
    // keeps writing the source project until the cutover switches it off: an
    // early run is a rehearsal, the authoritative run is inside the window.
    const doc: Record<string, unknown> = { nome: 'x', timestamp: 1_690_000_000_000 };
    const first = planUltimaModificacao(doc, FALLBACK);
    expect(first.action).toBe('change');
    if (first.action !== 'change') throw new Error('unreachable');

    doc.ultimaModificacao = first.to;
    expect(planUltimaModificacao(doc, FALLBACK)).toEqual({
      action: 'skip',
      reason: SKIP_REASON.present,
      value: 1_690_000_000_000,
    });
  });

  it('skips a produto that already carries a real stamp', () => {
    expect(
      planUltimaModificacao({ nome: 'x', ultimaModificacao: 1_695_000_000_000 }, FALLBACK),
    ).toEqual({ action: 'skip', reason: SKIP_REASON.present, value: 1_695_000_000_000 });
  });

  it('keys on PRESENCE, not truthiness — a 0 stamp is left alone', () => {
    // `0` is falsy and `!data.ultimaModificacao` would rewrite it; the key
    // exists, so the row is already indexed and must not move.
    expect(planUltimaModificacao({ ultimaModificacao: 0 }, FALLBACK)).toEqual({
      action: 'skip',
      reason: SKIP_REASON.present,
      value: 0,
    });
  });
});
