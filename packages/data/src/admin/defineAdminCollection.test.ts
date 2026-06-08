import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineAdminCollection } from './defineAdminCollection';

// A small strip-policy schema mirroring the shapes that matter: `.default()`
// fields (which must NOT leak into merge patches), a nullable field, and a
// required field (whose absence/typo must throw on a full write).
const schema = z.object({
  estado: z.string().default('0'),
  tpEmis: z.number().int().default(1),
  cStat: z.string().nullable(),
  nome: z.string().min(1),
});

const handle = defineAdminCollection({
  path: 'things/{thingId}/sub',
  schema,
});

// A `.passthrough()` schema (legacy-coexistence) — unknown keys are preserved,
// not rejected, on write.
const looseSchema = z.object({ nome: z.string().min(1) }).passthrough();
const looseHandle = defineAdminCollection({ path: 'loose', schema: looseSchema });

describe('defineAdminCollection', () => {
  describe('parse (full write)', () => {
    it('throws on a missing required field', () => {
      expect(() => handle.parse({ cStat: null })).toThrow();
    });

    it('throws on a wrong-typed field', () => {
      expect(() => handle.parse({ nome: 123, cStat: null })).toThrow();
    });

    it('applies defaults on a clean write', () => {
      const out = handle.parse({ nome: 'x', cStat: null });
      expect(out).toEqual({ nome: 'x', cStat: null, estado: '0', tpEmis: 1 });
    });

    it('throws on an unknown field (strip-policy schema)', () => {
      expect(() => handle.parse({ nome: 'x', cStat: null, bogus: 'nope' })).toThrow(z.ZodError);
    });

    it('preserves unknown fields on a .passthrough() schema', () => {
      const out = looseHandle.parse({ nome: 'x', legacyField: 42 });
      expect(out).toEqual({ nome: 'x', legacyField: 42 });
    });

    it('rejects a prototype-named unknown key (Object.hasOwn, not `in`)', () => {
      expect(() => handle.parse({ nome: 'x', cStat: null, toString: 'evil' })).toThrow(z.ZodError);
    });
  });

  describe('parseMerge (merge patch)', () => {
    it('keeps only the keys provided — never injects schema defaults', () => {
      const out = handle.parseMerge({ cStat: '100' });
      expect(out).toEqual({ cStat: '100' });
      // The crux: no `estado`/`tpEmis` default leaks in to clobber stored data.
      expect(Object.keys(out)).toEqual(['cStat']);
    });

    it('validates the provided keys', () => {
      expect(() => handle.parseMerge({ tpEmis: 'not-a-number' })).toThrow();
    });

    it('keeps null values (Firestore stores null fine)', () => {
      expect(handle.parseMerge({ cStat: null })).toEqual({ cStat: null });
    });

    it('drops keys that validate to undefined (Firestore rejects undefined)', () => {
      expect(handle.parseMerge({ cStat: undefined })).toEqual({});
    });

    it('throws on an unknown patch key (strip-policy schema)', () => {
      expect(() => handle.parseMerge({ bogus: 'nope' })).toThrow(z.ZodError);
    });

    it('throws on a prototype-named unknown patch key', () => {
      expect(() => handle.parseMerge({ toString: 'evil' })).toThrow(z.ZodError);
    });
  });

  describe('parseRead', () => {
    it('returns parsed data when valid', () => {
      const out = handle.parseRead({ nome: 'y', cStat: null });
      expect(out.nome).toBe('y');
    });

    it('tolerates unknown keys (reads stay lenient — no throw)', () => {
      const out = handle.parseRead({ nome: 'y', cStat: null, legacy: 1 });
      expect(out.nome).toBe('y');
    });

    it('falls back to raw and warns on mismatch (never throws)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const raw = { nome: 123 };
      const out = handle.parseRead(raw, 'things/abc/sub/1');
      expect(out).toBe(raw);
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    });
  });

  describe('resolvePath', () => {
    it('fills placeholders from context', () => {
      expect(handle.resolvePath({ thingId: 'abc' })).toBe('things/abc/sub');
    });

    it('throws when a placeholder is missing', () => {
      expect(() => handle.resolvePath({})).toThrow();
    });

    it('docPath returns the concrete collection/id path', () => {
      expect(handle.docPath({ thingId: 'abc' }, 'doc1')).toBe('things/abc/sub/doc1');
    });
  });
});
