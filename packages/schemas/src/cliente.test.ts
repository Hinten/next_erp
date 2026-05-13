import { describe, expect, it } from 'vitest';
import { TIPO_CLIENTE_LABELS, clienteMeta, clienteSchema } from './cliente';

describe('clienteSchema', () => {
  it('accepts a minimal cliente (all fields optional)', () => {
    expect(clienteSchema.parse({})).toEqual({});
  });

  it('accepts a fully-populated PF cliente', () => {
    const input = {
      tipo: '0' as const,
      nome: 'Maria Silva',
      cpf_cnpj: '12345678901',
      email: 'maria@example.com',
      telefone: '5511999998888',
      observacoesInternas: 'preferred client',
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    expect(clienteSchema.parse(input)).toEqual(input);
  });

  it('rejects cpf_cnpj with non-digit characters', () => {
    const result = clienteSchema.safeParse({ cpf_cnpj: '123.456.789-01' });
    expect(result.success).toBe(false);
  });

  it('rejects email with invalid format', () => {
    const result = clienteSchema.safeParse({ email: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('rejects nome longer than 255 chars', () => {
    const result = clienteSchema.safeParse({ nome: 'x'.repeat(256) });
    expect(result.success).toBe(false);
  });

  it('rejects unknown tipo values', () => {
    const result = clienteSchema.safeParse({ tipo: '9' });
    expect(result.success).toBe(false);
  });

  it('passes embedding fields through unchanged', () => {
    const embedding = { __vector: [0.1, 0.2, 0.3] };
    const parsed = clienteSchema.parse({ nome_embedding: embedding });
    expect(parsed.nome_embedding).toEqual(embedding);
  });
});

describe('clienteMeta', () => {
  it('points at the legacy Flutter collection path', () => {
    expect(clienteMeta.collectionPath).toBe('clientes');
  });

  it('declares the enderecos cascade', () => {
    expect(clienteMeta.cascade).toContainEqual({
      path: 'clientes/{clienteId}/enderecos',
      onDelete: 'cascade',
    });
  });
});

describe('TIPO_CLIENTE_LABELS', () => {
  it('has labels for every code', () => {
    expect(TIPO_CLIENTE_LABELS).toEqual({
      '0': 'Pessoa Física',
      '1': 'Pessoa Jurídica',
      '2': 'Estrangeiro',
    });
  });
});
