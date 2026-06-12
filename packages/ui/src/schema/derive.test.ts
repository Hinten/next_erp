import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractFieldsFromSchema } from './derive';

describe('extractFieldsFromSchema', () => {
  it('produces a descriptor per top-level key with default kinds', () => {
    const schema = z.object({
      nome: z.string(),
      idade: z.number(),
      ativo: z.boolean(),
    });
    const fields = extractFieldsFromSchema(schema);
    expect(fields.map((f) => f.key)).toEqual(['nome', 'idade', 'ativo']);
    expect(fields.map((f) => f.kind)).toEqual(['string', 'number', 'boolean']);
  });

  it('detects optional and nullable wrappers in either order', () => {
    const schema = z.object({
      a: z.string().nullable().optional(),
      b: z.string().optional().nullable(),
    });
    const fields = extractFieldsFromSchema(schema);
    const a = fields.find((f) => f.key === 'a')!;
    const b = fields.find((f) => f.key === 'b')!;
    expect(a.optional).toBe(true);
    expect(a.nullable).toBe(true);
    expect(b.optional).toBe(true);
    expect(b.nullable).toBe(true);
  });

  it('detects email, url, datetime as specialized string kinds', () => {
    const schema = z.object({
      e: z.string().email(),
      u: z.string().url(),
      d: z.string().datetime(),
    });
    const fields = extractFieldsFromSchema(schema);
    expect(fields.find((f) => f.key === 'e')!.kind).toBe('email');
    expect(fields.find((f) => f.key === 'u')!.kind).toBe('url');
    expect(fields.find((f) => f.key === 'd')!.kind).toBe('date');
  });

  it('detects integer for z.number().int()', () => {
    const schema = z.object({ n: z.number().int() });
    expect(extractFieldsFromSchema(schema)[0]!.kind).toBe('integer');
  });

  it('keeps a refined string introspectable (Zod 4 refine stays in-class)', () => {
    // clienteSchema relies on this: `.refine()` must not wrap the ZodString
    // in a pipe/effects type, or kind/nullable detection would break.
    const schema = z.object({
      doc: z
        .string()
        .regex(/^[0-9A-Z]*$/)
        .refine((v) => v.length !== 1)
        .nullable()
        .default(null),
    });
    const f = extractFieldsFromSchema(schema)[0]!;
    expect(f.kind).toBe('string');
    expect(f.nullable).toBe(true);
  });

  it('returns ZodDate as date', () => {
    const schema = z.object({ d: z.date() });
    expect(extractFieldsFromSchema(schema)[0]!.kind).toBe('date');
  });

  it('detects enum and lists values', () => {
    const schema = z.object({ t: z.enum(['a', 'b', 'c']) });
    const f = extractFieldsFromSchema(schema)[0]!;
    expect(f.kind).toBe('enum');
    expect(f.enumValues).toEqual([
      { value: 'a', label: 'a' },
      { value: 'b', label: 'b' },
      { value: 'c', label: 'c' },
    ]);
  });

  it('detects object-based enums (Zod 4 unified z.enum)', () => {
    // In Zod 4, `z.nativeEnum` is removed — `z.enum` accepts either an
    // array of strings or an object mapping label → value, the latter
    // being the native-enum-style flow.
    const schema = z.object({ c: z.enum({ Red: 'red', Blue: 'blue' }) });
    const f = extractFieldsFromSchema(schema)[0]!;
    expect(f.kind).toBe('enum');
    expect(f.enumValues).toEqual([
      { value: 'red', label: 'Red' },
      { value: 'blue', label: 'Blue' },
    ]);
  });

  it('marks arrays, objects, and unknowns', () => {
    const schema = z.object({
      arr: z.array(z.string()),
      obj: z.object({ x: z.string() }),
      un: z.unknown(),
    });
    const map = Object.fromEntries(extractFieldsFromSchema(schema).map((f) => [f.key, f.kind]));
    expect(map).toEqual({ arr: 'array', obj: 'object', un: 'unknown' });
  });

  it('reads a plain-string describe() as label', () => {
    const schema = z.object({ nome: z.string().describe('Razão social') });
    expect(extractFieldsFromSchema(schema)[0]!.label).toBe('Razão social');
  });

  it('reads a JSON describe() for reference fields', () => {
    const schema = z.object({
      clienteId: z
        .string()
        .describe('{"label":"Cliente","kind":"reference","collection":"clientes"}'),
    });
    const f = extractFieldsFromSchema(schema)[0]!;
    expect(f.kind).toBe('reference');
    expect(f.label).toBe('Cliente');
    expect(f.referenceCollection).toBe('clientes');
  });

  it('humanizes snake/camel case keys when no describe is set', () => {
    const schema = z.object({
      cpf_cnpj: z.string(),
      nomeCompleto: z.string(),
    });
    const map = Object.fromEntries(extractFieldsFromSchema(schema).map((f) => [f.key, f.label]));
    expect(map['cpf_cnpj']).toBe('Cpf cnpj');
    expect(map['nomeCompleto']).toBe('Nome Completo');
  });

  it('unwraps ZodDefault', () => {
    const schema = z.object({ s: z.string().default('x') });
    const f = extractFieldsFromSchema(schema)[0]!;
    expect(f.kind).toBe('string');
  });
});
