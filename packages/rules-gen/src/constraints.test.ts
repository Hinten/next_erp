import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { clausesForSchema } from './constraints';

function exprOf(schema: z.ZodTypeAny, field: string): string | undefined {
  return clausesForSchema(schema).find((cl) => cl.field === field)?.expr;
}

describe('clausesForSchema', () => {
  it('emits type + size for bounded strings, dropping regex patterns', () => {
    const schema = z.object({ nome: z.string().min(1).max(100), cpf: z.string().regex(/^\d*$/) });
    expect(exprOf(schema, 'nome')).toBe(
      "(!c.hasAny(['nome']) || d.get('nome', null) is string && d.get('nome', null).size() <= 100)",
    );
    expect(exprOf(schema, 'cpf')).toBe("(!c.hasAny(['cpf']) || d.get('cpf', null) is string)");
  });

  it('wraps nullable fields in a null-or arm', () => {
    const schema = z.object({ sku: z.string().max(10).nullable() });
    expect(exprOf(schema, 'sku')).toBe(
      "(!c.hasAny(['sku']) || (d.get('sku', null) == null || d.get('sku', null) is string && d.get('sku', null).size() <= 10))",
    );
  });

  it('maps enums to `in` lists', () => {
    const schema = z.object({ estado: z.enum(['a', 'b']) });
    expect(exprOf(schema, 'estado')).toBe(
      "(!c.hasAny(['estado']) || d.get('estado', null) in ['a', 'b'])",
    );
  });

  it('maps int fields to `is int`, stripping the 2^53 noise bounds', () => {
    const schema = z.object({ ordem: z.number().int(), qtd: z.number().int().min(0) });
    expect(exprOf(schema, 'ordem')).toBe("(!c.hasAny(['ordem']) || d.get('ordem', null) is int)");
    expect(exprOf(schema, 'qtd')).toBe(
      "(!c.hasAny(['qtd']) || (d.get('qtd', null) is int && d.get('qtd', null) >= 0))",
    );
  });

  it('keeps real numeric bounds', () => {
    const schema = z.object({ valor: z.number().min(0).max(10) });
    expect(exprOf(schema, 'valor')).toBe(
      "(!c.hasAny(['valor']) || (d.get('valor', null) is number && d.get('valor', null) >= 0 && d.get('valor', null) <= 10))",
    );
  });

  it('maps bool/array/object to shape checks without recursion', () => {
    const schema = z.object({
      ativo: z.boolean(),
      itens: z.array(z.object({ a: z.string() })),
      mapa: z.record(z.string(), z.unknown()),
    });
    expect(exprOf(schema, 'ativo')).toBe("(!c.hasAny(['ativo']) || d.get('ativo', null) is bool)");
    expect(exprOf(schema, 'itens')).toBe("(!c.hasAny(['itens']) || d.get('itens', null) is list)");
    expect(exprOf(schema, 'mapa')).toBe("(!c.hasAny(['mapa']) || d.get('mapa', null) is map)");
  });

  it('maps int-coded literals to equality', () => {
    const schema = z.object({ tipo: z.literal(1) });
    expect(exprOf(schema, 'tipo')).toBe("(!c.hasAny(['tipo']) || d.get('tipo', null) == 1)");
  });

  it('skips datetime fields entirely (Flutter writes real Timestamps)', () => {
    const schema = z.object({ timestamp: z.string().datetime().nullable() });
    expect(exprOf(schema, 'timestamp')).toBeUndefined();
  });

  it('skips unknown/any fields, including nullable ones', () => {
    const schema = z.object({
      blob: z.unknown(),
      ref: z.unknown().nullable(),
      uniao: z.union([z.string(), z.number()]),
    });
    expect(clausesForSchema(schema)).toEqual([]);
  });

  it('sorts clauses by field name for deterministic output', () => {
    const schema = z.object({ b: z.boolean(), a: z.boolean() });
    expect(clausesForSchema(schema).map((cl) => cl.field)).toEqual(['a', 'b']);
  });

  it('rejects non-object schemas', () => {
    expect(() => clausesForSchema(z.string())).toThrow(/object schemas/);
  });
});
