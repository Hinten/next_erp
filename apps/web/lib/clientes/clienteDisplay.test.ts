import { describe, expect, it } from 'vitest';
import { resolveClienteDisplay } from './clienteDisplay';

const ready = {
  hasReference: true,
  recognized: true,
  data: { nome: 'Ana' },
  isLoading: false,
  isError: false,
};

describe('resolveClienteDisplay', () => {
  it('does not use cached data for an absent or invalid reference', () => {
    expect(resolveClienteDisplay({ ...ready, hasReference: false })).toEqual({
      status: 'anonymous',
      label: 'Anônimo',
    });
    expect(resolveClienteDisplay({ ...ready, recognized: false })).toEqual({
      status: 'unrecognized',
      label: 'Cliente não reconhecido',
    });
  });

  it('gives a read error precedence over cached data and loading', () => {
    expect(resolveClienteDisplay({ ...ready, isError: true, isLoading: true })).toEqual({
      status: 'error',
      label: 'Cliente indisponível',
    });
  });

  it('keeps a disabled query without data pending', () => {
    expect(resolveClienteDisplay({ ...ready, data: undefined })).toEqual({ status: 'loading' });
    expect(resolveClienteDisplay({ ...ready, data: null, isLoading: true })).toEqual({
      status: 'loading',
    });
    expect(resolveClienteDisplay({ ...ready, data: null })).toEqual({
      status: 'missing',
      label: 'Cadastro não encontrado',
    });
  });

  it.each([undefined, null, '', '   '])('uses (sem nome) for %j', (nome) => {
    expect(resolveClienteDisplay({ ...ready, data: { nome } })).toEqual({
      status: 'found',
      label: '(sem nome)',
    });
  });

  it('preserves a nonblank name as stored', () => {
    expect(resolveClienteDisplay({ ...ready, data: { nome: ' Ana ' } })).toEqual({
      status: 'found',
      label: ' Ana ',
    });
  });
});
