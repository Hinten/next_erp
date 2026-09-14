import { describe, expect, it } from 'vitest';
import { effectiveUsuarioPermissoes, usuarioSchema, SUPERUSER_MASK } from './usuario';
describe('effective Auth permission policy', () => {
  const cargos = new Map([
    ['a', { permissoes: '3' }],
    ['b', { permissoes: '6' }],
  ]);
  const base = { nome: 'User', cargos: ['a', 'b', 'missing'], colaborador: true };
  it('unions all cargos for an active collaborator, including users without email', () => {
    expect(effectiveUsuarioPermissoes(usuarioSchema.parse(base), cargos)).toBe(7n);
  });
  it.each([{ ativo: false }, { colaborador: false }, { externalId: 'contact' }])(
    'revokes ineligible accounts: %j',
    (extra) => {
      expect(effectiveUsuarioPermissoes(usuarioSchema.parse({ ...base, ...extra }), cargos)).toBe(
        0n,
      );
    },
  );
  it('grants the superuser mask without requiring collaborator status', () => {
    expect(
      effectiveUsuarioPermissoes(
        usuarioSchema.parse({ ...base, colaborador: false, isSuperUser: true }),
        cargos,
      ),
    ).toBe(SUPERUSER_MASK);
  });
  it('inactive and external identity take precedence over superuser', () => {
    for (const extra of [{ ativo: false }, { externalId: 'contact' }]) {
      expect(
        effectiveUsuarioPermissoes(
          usuarioSchema.parse({ ...base, isSuperUser: true, ...extra }),
          cargos,
        ),
      ).toBe(0n);
    }
  });
});
