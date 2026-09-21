import { describe, expect, it } from 'vitest';
import { clienteSchema } from './cliente';
import { buildClienteTelefonePatch, ClienteTelefoneConflitoError } from './clienteTelefone';

const OLD = '5511999998888';
const NEW = '5511888887777';

describe('cliente phone state', () => {
  it('defaults the new fields on a legacy document', () => {
    expect(clienteSchema.parse({})).toMatchObject({
      telefonesAdicionais: [],
      telefoneGerenciado: false,
    });
  });

  it('lets an importer fill a never-managed empty phone only', () => {
    expect(buildClienteTelefonePatch({}, { tipo: 'observar', telefone: '11999998888' })).toEqual({
      telefone: OLD,
    });
    expect(
      buildClienteTelefonePatch({ telefone: NEW }, { tipo: 'observar', telefone: OLD }),
    ).toEqual({});
    expect(
      buildClienteTelefonePatch({ telefoneGerenciado: true }, { tipo: 'observar', telefone: OLD }),
    ).toEqual({});
    expect(
      buildClienteTelefonePatch(
        { telefonesAdicionais: [OLD] },
        { tipo: 'observar', telefone: OLD },
      ),
    ).toEqual({});
  });

  it('retires the previous primary when the operator changes it', () => {
    expect(
      buildClienteTelefonePatch({ telefone: OLD }, { tipo: 'manual', patch: { telefone: NEW } }),
    ).toEqual({
      telefone: NEW,
      telefonesAdicionais: [OLD],
      telefoneGerenciado: true,
    });
  });

  it('allows adding, correcting and removing extras without reactivating a phone', () => {
    const old = { telefone: null, telefonesAdicionais: [OLD], telefoneGerenciado: true };
    const removed = buildClienteTelefonePatch(old, {
      tipo: 'manual',
      patch: { telefonesAdicionais: [] },
    });
    expect(removed).toEqual({ telefonesAdicionais: [], telefoneGerenciado: true });
    expect(
      buildClienteTelefonePatch({ ...old, ...removed }, { tipo: 'observar', telefone: OLD }),
    ).toEqual({});
    expect(
      buildClienteTelefonePatch(old, {
        tipo: 'manual',
        patch: { telefonesAdicionais: [NEW, NEW] },
      }),
    ).toEqual({
      telefonesAdicionais: [NEW],
      telefoneGerenciado: true,
    });
  });

  it('preserves the marker against a copied false and leaves unrelated saves alone', () => {
    expect(
      buildClienteTelefonePatch(
        { telefoneGerenciado: true },
        { tipo: 'manual', patch: { telefoneGerenciado: false } },
      ),
    ).toEqual({ telefoneGerenciado: true });
    expect(
      buildClienteTelefonePatch(
        { telefoneGerenciado: true },
        { tipo: 'manual', patch: { nome: 'Ana' } },
      ),
    ).toEqual({});
  });

  it('folds BR formatting without adding the same phone to history', () => {
    expect(
      buildClienteTelefonePatch(
        { telefone: '11999998888' },
        { tipo: 'manual', patch: { telefone: OLD } },
      ),
    ).toEqual({
      telefone: '11999998888',
      telefoneGerenciado: true,
    });
  });

  it('keeps a ninth-digit near-miss and a foreign number distinct', () => {
    expect(
      buildClienteTelefonePatch(
        { telefone: OLD },
        { tipo: 'manual', patch: { telefone: '551199998888' } },
      ),
    ).toMatchObject({
      telefone: '551199998888',
      telefonesAdicionais: [OLD],
    });
    expect(
      buildClienteTelefonePatch(null, { tipo: 'manual', patch: { telefone: '14155552671' } }),
    ).toMatchObject({ telefone: '14155552671' });
    expect(
      buildClienteTelefonePatch(
        { telefone: '5514155552671' },
        { tipo: 'manual', patch: { telefone: '14155552671' } },
      ),
    ).toMatchObject({ telefone: '14155552671', telefonesAdicionais: ['5514155552671'] });
  });

  it('requires the WhatsApp predecessor to still be current', () => {
    expect(() =>
      buildClienteTelefonePatch(
        { telefone: NEW },
        { tipo: 'whatsapp', telefone: '14155552671', telefoneAnterior: OLD },
      ),
    ).toThrow(ClienteTelefoneConflitoError);
    expect(
      buildClienteTelefonePatch(
        { telefone: OLD },
        { tipo: 'whatsapp', telefone: '14155552671', telefoneAnterior: OLD },
      ),
    ).toMatchObject({
      telefone: '14155552671',
      telefonesAdicionais: [OLD],
      telefoneGerenciado: true,
    });
  });
});
