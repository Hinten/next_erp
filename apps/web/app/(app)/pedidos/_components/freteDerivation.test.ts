import { describe, expect, it } from 'vitest';
import { freteDoPedidoSchema } from '@delfrance/schemas';
import { normalizeFreteInicial } from './freteDerivation';
import type { FreteInicialFormState } from './types';

function freteWith(patch: Record<string, unknown>): FreteInicialFormState {
  return freteDoPedidoSchema.parse({
    estado: 'iniciado',
    modalidade: '0',
    ...patch,
  }) as unknown as FreteInicialFormState;
}

describe('normalizeFreteInicial', () => {
  it('null passes through', () => {
    expect(normalizeFreteInicial(null)).toBeNull();
    expect(normalizeFreteInicial(undefined)).toBeNull();
  });

  it('an all-empty transportadora collapses to null (legacy empty-map → null)', () => {
    const frete = freteWith({
      transportadora: { cnpj: null, ie: '', nome: '  ', endereco: null, municipio: null, uf: null },
    });
    expect(normalizeFreteInicial(frete)?.transportadora).toBeNull();
  });

  it('a partially filled transportadora is kept as-is', () => {
    const frete = freteWith({
      transportadora: {
        cnpj: null,
        ie: null,
        nome: 'Trans Dev',
        endereco: null,
        municipio: null,
        uf: null,
      },
    });
    expect(normalizeFreteInicial(frete)?.transportadora?.nome).toBe('Trans Dev');
  });

  it('does not touch the rest of the frete block', () => {
    const frete = freteWith({ valorCobrado: 15.5, transportadora: null });
    expect(normalizeFreteInicial(frete)).toBe(frete);
  });
});
