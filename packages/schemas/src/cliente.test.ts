import { describe, expect, it } from 'vitest';
import { TIPO_CLIENTE_LABELS, clienteMeta, clienteSchema } from './cliente';

describe('clienteSchema', () => {
  it('accepts a minimal cliente — missing fields default to null', () => {
    const out = clienteSchema.parse({});
    expect(out.tipo).toBeNull();
    expect(out.nome).toBeNull();
    expect(out.cpf_cnpj).toBeNull();
    expect(out.email).toBeNull();
  });

  it('accepts a fully-populated PF cliente', () => {
    const input = {
      tipo: '0' as const,
      nome: 'Maria Silva',
      cpf_cnpj: '52998224725',
      email: 'maria@example.com',
      telefone: '5511999998888',
      observacoesInternas: 'preferred client',
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const out = clienteSchema.parse(input);
    expect(out.tipo).toBe(input.tipo);
    expect(out.nome).toBe(input.nome);
    expect(out.cpf_cnpj).toBe(input.cpf_cnpj);
    expect(out.email).toBe(input.email);
    expect(out.telefone).toBe(input.telefone);
    expect(out.observacoesInternas).toBe(input.observacoesInternas);
    expect(out.timestamp).toBe(input.timestamp);
    // Unset fields default to null
    expect(out.idEstrangeiro).toBeNull();
    expect(out.ie).toBeNull();
  });

  it('rejects cpf_cnpj with punctuation', () => {
    const result = clienteSchema.safeParse({ cpf_cnpj: '123.456.789-01' });
    expect(result.success).toBe(false);
  });

  it('rejects cpf_cnpj with a bad checksum', () => {
    expect(clienteSchema.safeParse({ cpf_cnpj: '12345678901' }).success).toBe(false);
    expect(clienteSchema.safeParse({ cpf_cnpj: '11222333000182' }).success).toBe(false);
  });

  it('accepts checksum-valid CPF, numeric CNPJ and alphanumeric CNPJ', () => {
    expect(clienteSchema.safeParse({ cpf_cnpj: '52998224725' }).success).toBe(true);
    expect(clienteSchema.safeParse({ cpf_cnpj: '11222333000181' }).success).toBe(true);
    expect(clienteSchema.safeParse({ cpf_cnpj: '12ABC34501DE35' }).success).toBe(true);
  });

  it('rejects lowercase letters in cpf_cnpj (wire format is uppercase)', () => {
    expect(clienteSchema.safeParse({ cpf_cnpj: '12abc34501de35' }).success).toBe(false);
  });

  it('accepts empty and null cpf_cnpj', () => {
    expect(clienteSchema.safeParse({ cpf_cnpj: '' }).success).toBe(true);
    expect(clienteSchema.safeParse({ cpf_cnpj: null }).success).toBe(true);
  });

  it('accepts null, empty, raw-BR and normalized telefone', () => {
    expect(clienteSchema.safeParse({ telefone: null }).success).toBe(true);
    expect(clienteSchema.safeParse({ telefone: '' }).success).toBe(true);
    expect(clienteSchema.safeParse({ telefone: '11999998888' }).success).toBe(true);
    expect(clienteSchema.safeParse({ telefone: '5511999998888' }).success).toBe(true);
  });

  it('rejects too-short and non-digit telefone', () => {
    expect(clienteSchema.safeParse({ telefone: '999988887' }).success).toBe(false);
    expect(clienteSchema.safeParse({ telefone: '(11) 99999-8888' }).success).toBe(false);
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
