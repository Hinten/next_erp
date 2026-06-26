import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClienteCnpjEndereco } from './consultaCnpj';
import { popEnderecoForCliente, stashEnderecoForCliente } from './pendingEndereco';

const ENDERECO: ClienteCnpjEndereco = {
  cep: '01310100',
  logradouro: 'AVENIDA PAULISTA',
  numero: '1000',
  complemento: '',
  bairro: 'BELA VISTA',
  cidade: 'SAO PAULO',
  estado: 'SP',
  codigoMunicipio: '3550308',
};

describe('pendingEndereco relay', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('round-trips a stashed address via localStorage (survives a new tab)', () => {
    stashEnderecoForCliente('cli-1', ENDERECO);
    // Persisted under the cliente-keyed localStorage entry — not sessionStorage,
    // so a target="_blank" (noopener) tab can read it.
    expect(window.localStorage.getItem('cliente-cnpj-endereco:cli-1')).toContain(
      'AVENIDA PAULISTA',
    );
    expect(window.sessionStorage.getItem('cliente-cnpj-endereco:cli-1')).toBeNull();
    expect(popEnderecoForCliente('cli-1')).toEqual(ENDERECO);
  });

  it('consumes once — a second pop is null and the key is removed', () => {
    stashEnderecoForCliente('cli-1', ENDERECO);
    expect(popEnderecoForCliente('cli-1')).toEqual(ENDERECO);
    expect(popEnderecoForCliente('cli-1')).toBeNull();
    expect(window.localStorage.getItem('cliente-cnpj-endereco:cli-1')).toBeNull();
  });

  it('returns null for a different cliente id', () => {
    stashEnderecoForCliente('cli-1', ENDERECO);
    expect(popEnderecoForCliente('cli-2')).toBeNull();
  });

  it('returns the address when popped within the TTL', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    stashEnderecoForCliente('cli-1', ENDERECO);
    now.mockReturnValue(1_000_000 + 5 * 60 * 1000);
    expect(popEnderecoForCliente('cli-1')).toEqual(ENDERECO);
  });

  it('ignores (and discards) a stash older than the TTL', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    stashEnderecoForCliente('cli-1', ENDERECO);
    // 31 minutes later — past the 30-min TTL.
    now.mockReturnValue(1_000_000 + 31 * 60 * 1000);
    expect(popEnderecoForCliente('cli-1')).toBeNull();
    expect(window.localStorage.getItem('cliente-cnpj-endereco:cli-1')).toBeNull();
  });

  it('treats a corrupt payload as nothing stashed', () => {
    window.localStorage.setItem('cliente-cnpj-endereco:cli-1', '<<not json>>');
    expect(popEnderecoForCliente('cli-1')).toBeNull();
  });
});
