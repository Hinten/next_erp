import { describe, expect, it } from 'vitest';
import { conflictFields } from './conflictFields';

describe('conflictFields', () => {
  it('lists fields changed remotely, with schema labels + loaded/server values', () => {
    const result = conflictFields(
      { numero: 'A', descontoTotal: 5 },
      { numero: 'B', descontoTotal: 5 },
      {},
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      field: 'numero',
      label: 'Número',
      loaded: 'A',
      server: 'B',
      complex: false,
      overwritten: false,
    });
  });

  it('is empty when nothing changed remotely', () => {
    expect(conflictFields({ numero: 'A' }, { numero: 'A' }, { numero: 'Z' })).toEqual([]);
  });

  it('flags overwritten=true when the pending patch also touches the changed field', () => {
    // Both the backend and the user changed cliente → real data-loss risk.
    const result = conflictFields(
      { clientePedidoOuterRef: 'documents/clientes/1' },
      { clientePedidoOuterRef: 'documents/clientes/2' },
      { clientePedidoOuterRef: 'documents/clientes/3' },
    );
    expect(result[0]).toMatchObject({ overwritten: true });
  });

  it('flags overwritten=false when the user is not touching the remote change', () => {
    // The reported scenario: backend changed itens, the user only changed cliente.
    const result = conflictFields(
      { itens: { p1: [{ quantidade: 1 }] } },
      { itens: { p1: [{ quantidade: 5 }] } },
      { clientePedidoOuterRef: 'documents/clientes/1' },
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      field: 'itens',
      label: 'Itens',
      complex: true,
      overwritten: false,
    });
  });

  it('ignores ultimaModificacao stamp-only differences', () => {
    expect(conflictFields({ ultimaModificacao: 1 }, { ultimaModificacao: 2 }, {})).toEqual([]);
  });

  it('falls back to the field name when there is no schema label', () => {
    const result = conflictFields({ algumCampoNovo: 1 }, { algumCampoNovo: 2 }, {});
    expect(result[0]).toMatchObject({ label: 'algumCampoNovo' });
  });
});
