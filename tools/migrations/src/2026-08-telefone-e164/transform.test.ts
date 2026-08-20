import { describe, expect, it } from 'vitest';
import { buildUpdate, planTelefone, readNested, SKIP_REASON } from './transform';
import { resolveTargets, UnknownTargetError } from './migrate';

describe('planTelefone', () => {
  it('normalizes a raw 10/11-digit BR number — the Flutter shape', () => {
    expect(planTelefone('11999998888')).toEqual({
      action: 'change',
      from: '11999998888',
      to: '5511999998888',
    });
    expect(planTelefone('1133334444')).toEqual({
      action: 'change',
      from: '1133334444',
      to: '551133334444',
    });
  });

  it('normalizes a punctuated value', () => {
    expect(planTelefone('(11) 99999-8888')).toMatchObject({ to: '5511999998888' });
    expect(planTelefone('+55 11 99999-8888')).toMatchObject({ to: '5511999998888' });
  });

  it('is IDEMPOTENT — an already-canonical value is skipped, not rewritten', () => {
    // This is what makes the migration re-runnable, which matters because the
    // legacy app keeps writing the raw shape into the source project until the
    // cutover switches it off.
    expect(planTelefone('5511999998888')).toEqual({
      action: 'skip',
      reason: SKIP_REASON.alreadyNormalized,
      value: '5511999998888',
    });
  });

  it('re-planning its own output is always a skip', () => {
    const first = planTelefone('11999998888');
    expect(first.action).toBe('change');
    if (first.action !== 'change') return;
    expect(planTelefone(first.to).action).toBe('skip');
  });

  it('skips a MASKED value — normalizing would invent digits', () => {
    expect(planTelefone('11*****8888')).toMatchObject({
      action: 'skip',
      reason: SKIP_REASON.masked,
    });
  });

  it('skips anything that would fail clienteSchema after normalization', () => {
    // Writing one of these makes the record unsavable from the web form —
    // strictly worse than leaving it alone.
    expect(planTelefone('123')).toMatchObject({ action: 'skip', reason: SKIP_REASON.invalid });
    expect(planTelefone('sem telefone')).toMatchObject({
      action: 'skip',
      reason: SKIP_REASON.invalid,
    });
    expect(planTelefone('9'.repeat(16))).toMatchObject({
      action: 'skip',
      reason: SKIP_REASON.invalid,
    });
  });

  it('leaves a foreign number alone — it already carries a country code', () => {
    expect(planTelefone('441632960961')).toMatchObject({
      action: 'skip',
      reason: SKIP_REASON.alreadyNormalized,
    });
  });

  it('treats absent, empty and non-string as nothing to do', () => {
    for (const value of [null, undefined, '', '   ', 11999998888, {}, []]) {
      expect(planTelefone(value)).toMatchObject({ action: 'skip', reason: SKIP_REASON.empty });
    }
  });
});

describe('readNested', () => {
  it('reads a top-level and a nested field', () => {
    expect(readNested({ telefone: '11999998888' }, ['telefone'])).toBe('11999998888');
    expect(readNested({ sede: { telefone: '11999998888' } }, ['sede', 'telefone'])).toBe(
      '11999998888',
    );
  });

  it('returns undefined for a missing or non-object segment instead of throwing', () => {
    // These documents predate the schema and are read raw.
    expect(readNested({}, ['sede', 'telefone'])).toBeUndefined();
    expect(readNested({ sede: null }, ['sede', 'telefone'])).toBeUndefined();
    expect(readNested({ sede: 'nao-e-objeto' }, ['sede', 'telefone'])).toBeUndefined();
  });
});

describe('buildUpdate', () => {
  it('emits a DOTTED key so a nested map is not replaced', () => {
    // `update({ sede: { telefone } })` would wipe every sibling field of
    // `sede`; the dotted form touches exactly the one leaf.
    expect(buildUpdate(['sede', 'telefone'], '5511999998888')).toEqual({
      'sede.telefone': '5511999998888',
    });
    expect(buildUpdate(['telefone'], '5511999998888')).toEqual({ telefone: '5511999998888' });
  });
});

describe('resolveTargets', () => {
  it('defaults to clientes alone — the endereço family is opt-in', () => {
    // Those feed Melhor Envio's from.phone/to.phone, and whether ME accepts a
    // 55-prefixed value is still open.
    expect(resolveTargets([]).map((t) => t.name)).toEqual(['clientes']);
  });

  it('resolves an explicit selection in the order given', () => {
    expect(resolveTargets(['cheque', 'clientes']).map((t) => t.name)).toEqual([
      'cheque',
      'clientes',
    ]);
  });

  it('rejects an unknown target rather than silently migrating nothing', () => {
    expect(() => resolveTargets(['clientes', 'typo'])).toThrow(UnknownTargetError);
  });

  it('de-duplicates — a repeated target must not scan the group twice', () => {
    // Each target is an unindexed collection-group scan on Enterprise, billed
    // by data scanned, so a duplicate silently doubles the bill for no work.
    expect(resolveTargets(['clientes', 'clientes']).map((t) => t.name)).toEqual(['clientes']);
    expect(resolveTargets(['cheque', 'clientes', 'cheque']).map((t) => t.name)).toEqual([
      'cheque',
      'clientes',
    ]);
  });
});
