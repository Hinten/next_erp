import { describe, expect, it } from 'vitest';
import { clienteSchema } from '@delfrance/schemas';
import { CLIENTE_FORM_FIELDS, deriveClienteTelefonePatch, prepareClienteCopy } from './formFields';

describe('cliente copy phone provenance', () => {
  it('creates a copy with an unchanged US phone, excluding source identity and phone history', () => {
    const source = {
      nome: 'Cliente',
      telefone: '14155552671',
      telefoneGerenciado: true,
      telefonesAdicionais: ['5511999998888'],
      userCliente: 'documents/usuarios/legacy',
    };
    const copy = prepareClienteCopy(source);
    expect(copy.telefone).toBe('+14155552671');
    const patch = { ...copy, telefone: CLIENTE_FORM_FIELDS.telefone.prepareForSave(copy.telefone) };
    const saved = clienteSchema.parse({ ...patch, ...deriveClienteTelefonePatch(null, patch) });
    expect(saved).toMatchObject({
      telefone: '14155552671',
      telefonesAdicionais: [],
      userCliente: null,
      telefoneGerenciado: true,
    });
    expect(source.telefonesAdicionais).toEqual(['5511999998888']);
  });
  it('retains manual BR interpretation after the copied phone is edited', () => {
    const copy = prepareClienteCopy({ telefone: '14155552671', telefoneGerenciado: true });
    expect(CLIENTE_FORM_FIELDS.telefone.prepareForSave('11999998888')).toBe('5511999998888');
    expect(CLIENTE_FORM_FIELDS.telefone.prepareForSave(copy.telefone)).toBe('14155552671');
  });
  it('keeps an imported international phone canonical even before its first manual edit', () => {
    const copy = prepareClienteCopy({ telefone: '14155552671', telefoneGerenciado: false });
    expect(copy.telefone).toBe('+14155552671');
    expect(CLIENTE_FORM_FIELDS.telefone.prepareForSave(copy.telefone)).toBe('14155552671');
  });
});
