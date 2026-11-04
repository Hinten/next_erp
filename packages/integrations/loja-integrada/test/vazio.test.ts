import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { inteiroOpcional, numeroOpcional, vazioComoNulo } from '../src/vazio';

/**
 * Each helper is read as a key of an object, as the schemas use it, so an
 * ABSENT key is a real case rather than an `undefined` passed in.
 */
function ler(folha: z.ZodType, entrada: Record<string, unknown>) {
  return z.object({ v: folha }).safeParse(entrada);
}

const NUMERICAS = [
  ['inteiroOpcional', inteiroOpcional()],
  ['numeroOpcional', numeroOpcional()],
] as const;

describe.each(NUMERICAS)('%s', (_nome, folha) => {
  it("`''` reads as null — never 0", () => {
    const r = ler(folha, { v: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.v).toBeNull();
  });

  it.each([['   '], [' '], ['abc'], ['1,5'], [true], [{}]])(
    'near-miss: %j is still refused, at its own path',
    (v) => {
      const r = ler(folha, { v });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.map((i) => i.path)).toEqual([['v']]);
    },
  );

  it('null stays null, and an absent key stays undefined', () => {
    const nulo = ler(folha, { v: null });
    expect(nulo.success).toBe(true);
    if (nulo.success) expect(nulo.data.v).toBeNull();
    const ausente = ler(folha, {});
    expect(ausente.success).toBe(true);
    if (ausente.success) expect(ausente.data.v).toBeUndefined();
  });

  it.each([[7], ['7'], [0], ['0']])('%j still reads as a number', (v) => {
    const r = ler(folha, { v });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.v).toBe(Number(v));
  });
});

describe('the two numeric forms differ only where wireInt and wireNumber do', () => {
  it.each([['2.5'], [2.5]])('%j: a fraction is an amount, never a count', (v) => {
    expect(ler(inteiroOpcional(), { v }).success).toBe(false);
    const r = ler(numeroOpcional(), { v });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.v).toBe(2.5);
  });
});

describe('vazioComoNulo over an object', () => {
  const folha = vazioComoNulo(z.object({ id: z.string() }).passthrough());

  it("`''` reads as null, and an object parses as itself", () => {
    const vazio = ler(folha, { v: '' });
    expect(vazio.success).toBe(true);
    if (vazio.success) expect(vazio.data.v).toBeNull();
    const objeto = ler(folha, { v: { id: 'x', extra: 1 } });
    expect(objeto.success).toBe(true);
    if (objeto.success) expect(objeto.data.v).toEqual({ id: 'x', extra: 1 });
  });

  it.each([[' '], ['x'], [[]]])('near-miss: %j is still refused', (v) => {
    expect(ler(folha, { v }).success).toBe(false);
  });
});
