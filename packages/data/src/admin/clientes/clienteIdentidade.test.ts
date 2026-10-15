import { describe, expect, it } from 'vitest';
import { TIPO_CLIENTE, type Cliente, type ClienteResolveFields } from '@delfrance/schemas';
import {
  buildClienteIdentidadeData,
  clienteIdentidadeId,
  clienteIdentidadesDosCampos,
  clientePossuiIdentidade,
} from './clienteIdentidade';

const CPF = '52998224725';

function fields(overrides: Partial<ClienteResolveFields> = {}): ClienteResolveFields {
  return {
    tipo: TIPO_CLIENTE.pessoaFisica,
    nome: 'Ana',
    cpf_cnpj: null,
    idEstrangeiro: null,
    ie: null,
    telefone: null,
    email: null,
    ...overrides,
  };
}

describe('clienteIdentidadeId', () => {
  it('folds formatted and canonical CPF to the same opaque document id', () => {
    const canonical = clienteIdentidadesDosCampos(fields({ cpf_cnpj: CPF }))[0]!;
    const formatted = clienteIdentidadesDosCampos(fields({ cpf_cnpj: '529.982.247-25' }))[0]!;
    expect(formatted.id).toBe(canonical.id);
    expect(canonical.id).toMatch(/^[a-f0-9]{64}$/);
    expect(canonical.id).not.toContain(CPF);

    const persisted = buildClienteIdentidadeData(formatted, ['cli-b', 'cli-a', 'cli-a'], 123);
    expect(persisted).toEqual({
      tipo: 'cpf_cnpj',
      clienteIds: ['cli-a', 'cli-b'],
      ultimaModificacao: 123,
    });
    expect(JSON.stringify(persisted)).not.toContain(CPF);
    expect(JSON.stringify(persisted)).not.toContain('529.982.247-25');
  });

  it('folds only documento punctuation/case and keeps a near-miss distinct', () => {
    const first = clienteIdentidadesDosCampos(fields({ idEstrangeiro: 'ab-123 / 45' }))[0]!;
    const equivalent = clienteIdentidadesDosCampos(fields({ idEstrangeiro: 'AB12345' }))[0]!;
    const nearMiss = clienteIdentidadesDosCampos(fields({ idEstrangeiro: 'AB12346' }))[0]!;
    expect(first.id).toBe(equivalent.id);
    expect(first.id).not.toBe(nearMiss.id);
  });

  it('trims a Mercado Livre id but never folds punctuation', () => {
    expect(clienteIdentidadeId('idMercadoLivre', '301-110805')).not.toBe(
      clienteIdentidadeId('idMercadoLivre', '301110805'),
    );
    const specs = clienteIdentidadesDosCampos(fields({ idMercadoLivre: ' 301-110805 ' }));
    expect(specs[0]?.valorNormalizado).toBe('301-110805');
  });

  it.each(['', '   ', '.-/', ' / . '])(
    'treats a blank or punctuation-only document %j as absent',
    (documento) => {
      expect(clienteIdentidadesDosCampos(fields({ cpf_cnpj: documento }))).toEqual([]);
      expect(clienteIdentidadesDosCampos(fields({ idEstrangeiro: documento }))).toEqual([]);
      expect(clienteIdentidadesDosCampos(fields({ cpf_cnpj: CPF }))).toHaveLength(1);
    },
  );
});

describe('clientePossuiIdentidade', () => {
  it('validates the live cliente before trusting a side-index owner', () => {
    const spec = clienteIdentidadesDosCampos(fields({ cpf_cnpj: CPF }))[0]!;
    const cliente = {
      cpf_cnpj: '529.982.247-25',
    } as Cliente;
    expect(clientePossuiIdentidade(cliente, spec)).toBe(true);
    expect(clientePossuiIdentidade({ ...cliente, cpf_cnpj: '11144477735' }, spec)).toBe(false);
    expect(clientePossuiIdentidade({ ...cliente, cpf_cnpj: null }, spec)).toBe(false);
  });
});
