import { describe, expect, it } from 'vitest';
import { conflictFields } from './conflictFields';

describe('conflictFields', () => {
  it('lists fields where the user value differs from the server, with schema labels', () => {
    const result = conflictFields(
      { numero: 'B', descontoTotal: 10 },
      { numero: 'A', descontoTotal: 10 },
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      field: 'numero',
      label: 'Número',
      server: 'A',
      mine: 'B',
      complex: false,
    });
  });

  it('omits fields whose value matches the server', () => {
    expect(conflictFields({ numero: 'A' }, { numero: 'A' })).toEqual([]);
  });

  it('treats a missing (undefined) server value as null', () => {
    const result = conflictFields({ observacoesInternas: 'x' }, {});
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ server: null, mine: 'x' });
  });

  it('flags whitelisted complex fields (itens) as complex with a clean label', () => {
    const result = conflictFields(
      { itens: { p1: [{ quantidade: 2 }] } },
      { itens: { p1: [{ quantidade: 1 }] } },
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ complex: true, label: 'Itens' });
  });

  it('flags any object/array value as complex (e.g. outer refs)', () => {
    const result = conflictFields(
      { vendedorPedidoOuterRef: { id: 'a' } },
      { vendedorPedidoOuterRef: { id: 'b' } },
    );
    expect(result[0]).toMatchObject({ complex: true });
  });

  it('skips ultimaModificacao (the guard field)', () => {
    expect(conflictFields({ ultimaModificacao: 999 }, { ultimaModificacao: 1 })).toEqual([]);
  });

  it('falls back to the field name when there is no schema label', () => {
    const result = conflictFields({ algumCampoNovo: 1 }, { algumCampoNovo: 2 });
    expect(result[0]).toMatchObject({ label: 'algumCampoNovo' });
  });
});
