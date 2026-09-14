import { describe, expect, it } from 'vitest';
import { cargoSchema } from '../cargo';
import { usuarioSchema } from '../usuario';
import {
  cargoAccessSchema,
  cargoEditorReadSchema,
  usuarioAccessSchema,
  usuarioEditorReadSchema,
} from './accessRead';

describe('access read boundaries', () => {
  it('opens legacy presentation fields without weakening command validation', () => {
    const cargo = cargoEditorReadSchema.parse({ nome: '', permissoes: '3', legacy: true });
    expect(cargo).toMatchObject({ nome: '', descricao: null, permissoes: '3' });
    expect(cargoSchema.safeParse(cargo).success).toBe(false);
    const user = usuarioEditorReadSchema.parse({
      nome: 'Legacy',
      email: 'invalid address',
      ultimoAcesso: 'unparseable',
      colaborador: true,
      ativo: true,
      cargos: ['role'],
    });
    expect(user).toMatchObject({ email: 'invalid address', ultimoAcesso: null, cargos: ['role'] });
    expect(usuarioSchema.safeParse(user).success).toBe(false);
  });
  it('accepts unrelated invalid types and additional fields for authorization', () => {
    expect(
      usuarioAccessSchema.parse({ email: 17, nome: null, legacy: {}, ativo: false }).ativo,
    ).toBe(false);
    expect(cargoAccessSchema.parse({ nome: null, permissoes: '3' }).permissoes).toBe('3');
  });
  it.each([
    { ativo: 1 },
    { colaborador: 'true' },
    { isSuperUser: 'false' },
    { cargos: 'role' },
    { cargos: [17] },
    { externalId: 17 },
  ])('rejects malformed authorization in both readers: %j', (bad) => {
    expect(usuarioAccessSchema.safeParse(bad).success).toBe(false);
    expect(usuarioEditorReadSchema.safeParse({ nome: 'User', ...bad }).success).toBe(false);
  });
  it.each(['-1', 'not-a-mask', 3])('rejects invalid masks in both readers: %s', (permissoes) => {
    expect(cargoAccessSchema.safeParse({ permissoes }).success).toBe(false);
    expect(cargoEditorReadSchema.safeParse({ nome: 'Role', permissoes }).success).toBe(false);
  });
});
