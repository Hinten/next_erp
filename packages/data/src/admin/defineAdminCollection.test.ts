import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineAdminCollection } from './defineAdminCollection';

// A small schema that mirrors the shapes that matter: `.default()` fields
// (which must NOT leak into merge patches), a nullable field, and a required
// field (whose absence/typo must throw on a full write).
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

describe('defineAdminCollection', () => {
  describe('parse (full write)', () => {
    it('throws on a missing required field', () => {
      expect(() => handle.parse({ cStat: null })).toThrow();
    });

    it('throws on a wrong-typed field', () => {
      expect(() => handle.parse({ nome: 123, cStat: null })).toThrow();
    });

    it('applies defaults and strips unknown fields', () => {
      const out = handle.parse({ nome: 'x', cStat: null, bogus: 'nope' });
      expect(out).toEqual({ nome: 'x', cStat: null, estado: '0', tpEmis: 1 });
      expect('bogus' in (out as Record<string, unknown>)).toBe(false);
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
  });

  describe('parseRead', () => {
    it('returns parsed data when valid', () => {
      const out = handle.parseRead({ nome: 'y', cStat: null });
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
  });
});
