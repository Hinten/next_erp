import { describe, expect, it } from 'vitest';

import * as contas from './contas';
import { ID_DE_CONTA, idDeContaValido } from './idConta';

describe('idDeContaValido', () => {
  it.each(['abc', 'AbC_09-x', 'a'.repeat(128), 'Xy3kP0q9RZ2LmNbV7tWc'])('accepts %j', (id) => {
    expect(idDeContaValido(id)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a slash', 'a/b'],
    ['a dot', 'a.b'],
    ['dot-dot', '..'],
    ['a space', 'a b'],
    ['a trailing newline', 'abc\n'],
    ['too long', 'a'.repeat(129)],
    ['non-ASCII', 'conta-é'],
    ['a number', 123],
    ['null', null],
    ['undefined', undefined],
  ])('refuses %s', (_c, id) => {
    expect(idDeContaValido(id)).toBe(false);
  });

  it('pins the grammar', () => {
    expect(ID_DE_CONTA.source).toBe('^[A-Za-z0-9_-]{1,128}$');
  });

  it('core/contas.ts re-exports the SAME function — one copy, no drift', () => {
    expect(contas.idDeContaValido).toBe(idDeContaValido);
  });
});
