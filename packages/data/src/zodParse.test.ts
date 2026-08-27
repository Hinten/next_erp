import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseForWrite, parseMergePatch, parseSoftRead } from './zodParse';

/**
 * The read/write ASYMMETRY around an unmodelled key — the property that decides
 * whether retiring a schema field is safe.
 *
 * It had no direct coverage, which is how #1161 (retiring `usuario.apelido`)
 * reached review with only the read half pinned. Reads STRIP silently; writes
 * THROW. Both halves are load-bearing and they point in opposite directions, so
 * neither one implies the other.
 */

/** A strip-policy schema, like `usuarioSchema` — the common case. */
const strip = z.object({
  nome: z.string(),
  email: z.string().nullable().default(null),
});

/** A `.passthrough()` schema, like the legacy/marketplace wire shapes. */
const passthrough = z
  .object({
    nome: z.string(),
  })
  .passthrough();

/**
 * A strip-policy schema with a NESTED strip-policy array, like
 * `pedidoSchema.itens: z.record(z.string(), z.array(itemDoPedidoSchema))`.
 */
const withNestedArray = z.object({
  nome: z.string(),
  itens: z.array(z.object({ sku: z.string() })).default([]),
});

describe('parseForWrite', () => {
  it('accepts a document with only modelled keys', () => {
    expect(parseForWrite(strip, { nome: 'Ana' })).toMatchObject({ nome: 'Ana', email: null });
  });

  it('THROWS on an unmodelled key, naming it', () => {
    // ⚠️ The half a "does a legacy doc still read?" test does not cover. Once a
    // field is retired, writing a RAW doc that still carries it stops working —
    // silently on read, loudly here. Safe only because every write site builds a
    // fresh literal rather than spreading a stored document.
    expect(() => parseForWrite(strip, { nome: 'Ana', apelido: 'X' })).toThrow(/nrecognized/);
  });

  it('does NOT throw for a `.passthrough()` schema — it never drops a key', () => {
    // The strict re-check is gated on the schema having stripped something, so a
    // passthrough schema (legacy wire shapes) keeps its unknown fields.
    expect(parseForWrite(passthrough, { nome: 'Ana', extra: 1 })).toMatchObject({
      nome: 'Ana',
      extra: 1,
    });
  });

  it('is not fooled by a prototype key masquerading as known', () => {
    // `Object.hasOwn`, not `in` — otherwise `toString` would look "kept" and the
    // strict re-check would never fire for a payload carrying it.
    expect(() => parseForWrite(strip, { nome: 'Ana', toString: 'x' })).toThrow(/nrecognized/);
  });

  // ⚠️ The dropped-key diff above is TOP-LEVEL ONLY, and Zod's `.strict()` does
  // not recurse into a nested schema — so the "writes THROW" half of the
  // asymmetry this file documents does not hold for a key inside a nested
  // array/record item (e.g. `pedidoSchema.itens[*]`). Found in review on #1246
  // (a doc comment claimed the item level threw too).
  it('does NOT throw for an unmodelled key on a NESTED item — it is silently stripped', () => {
    const out = parseForWrite(withNestedArray, {
      nome: 'Ana',
      itens: [{ sku: 'A1', bogusItemKey: 'x' }],
    });
    expect(out.itens[0]).not.toHaveProperty('bogusItemKey');
  });
});

describe('parseMergePatch', () => {
  it('keeps only the supplied modelled keys', () => {
    expect(parseMergePatch(strip, { nome: 'Ana' })).toEqual({ nome: 'Ana' });
  });

  it('THROWS on an unmodelled key, same as the full write', () => {
    expect(() => parseMergePatch(strip, { apelido: 'X' })).toThrow(/nrecognized/);
  });
});

describe('parseSoftRead', () => {
  it('STRIPS an unmodelled key instead of throwing — the opposite of the write path', () => {
    // This is why retiring a field is safe on the read side: the migrated corpus
    // keeps the key, and every reader simply stops seeing it.
    const out = parseSoftRead(strip, { nome: 'Ana', apelido: 'X' }, 'usuarios/u1') as Record<
      string,
      unknown
    >;
    expect(out.nome).toBe('Ana');
    expect(out).not.toHaveProperty('apelido');
  });
});
