import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pagamentoSchema } from '@delfrance/schemas';
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

/**
 * `pedidos/{pedidoId}/pagamentos` is one of the five `VALIDATOR_WHITELIST`
 * entries, so every nullable field added to `pagamentoSchema` costs one clause
 * in BOTH rulesets and both committed snapshots (#1533's class). Step 6 (#1514)
 * added exactly two — asserted here, at the generator, so the cost of a third is
 * visible where it is incurred rather than only in a snapshot diff.
 */
describe('clausesForSchema(pagamentoSchema) — the step-6 marketplace fields', () => {
  const mapClauses = clausesForSchema(pagamentoSchema).filter((cl) => cl.expr.includes('is map'));

  it('emits ONE `is map` clause for `liquidacao` and one for `marketplace`, and no others', () => {
    // Exhaustive, not `toContain`: `cartao` and `cheque` are `z.unknown()` and
    // must stay unconstrained (they round-trip opaque legacy maps), so a third
    // `is map` here would mean a field silently changed shape.
    expect(mapClauses.map((cl) => cl.field)).toEqual(['liquidacao', 'marketplace']);
  });

  it('guards each one behind hasAny and lets null through (both are nullable)', () => {
    expect(exprOf(pagamentoSchema, 'liquidacao')).toBe(
      "(!c.hasAny(['liquidacao']) || (d.get('liquidacao', null) == null || d.get('liquidacao', null) is map))",
    );
    expect(exprOf(pagamentoSchema, 'marketplace')).toBe(
      "(!c.hasAny(['marketplace']) || (d.get('marketplace', null) == null || d.get('marketplace', null) is map))",
    );
  });

  it('does not recurse: the nested escrow fields emit nothing of their own', () => {
    // The generator is shape-only by design (expression budget). The near-miss
    // that would prove otherwise — a clause naming a field that exists ONLY
    // inside the nested block — must be absent.
    const fields = clausesForSchema(pagamentoSchema).map((cl) => cl.field);
    expect(fields).not.toContain('escrowReleaseTimeUs');
    expect(fields).not.toContain('tarifasBrutas');
    // The anchor: the top-level namesake IS there, so the two absences above
    // are recursion not happening, not the scan finding nothing.
    expect(fields).toContain('tarifas');
  });
});
