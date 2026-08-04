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

    it('an explicitly-undefined DEFAULTED key never leaks its default', () => {
      // Zod's `.partial()` does not suppress `.default()`: parsed naively,
      // `{ estado: undefined }` validates to `{ estado: '0' }` and the merge
      // would overwrite the stored estado. The undefined-strip prevents that.
      expect(handle.parseMerge({ estado: undefined })).toEqual({});
      expect(handle.parseMerge({ estado: undefined, cStat: '100' })).toEqual({ cStat: '100' });
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

  describe('newDocId', () => {
    it('mints an id from the resolved collection ref without writing', () => {
      const doc = vi.fn(() => ({ id: 'minted-id' }));
      const collection = vi.fn(() => ({ doc }));
      const db = { collection } as unknown as Parameters<typeof handle.newDocId>[0];
      expect(handle.newDocId(db, { thingId: 'abc' })).toBe('minted-id');
      expect(collection).toHaveBeenCalledWith('things/abc/sub');
      expect(doc).toHaveBeenCalledWith(); // no args → Firestore auto-id
    });
  });

  describe('mergeIfExists', () => {
    /** A db whose `update()` resolves, or rejects with a gRPC-coded Error. */
    function fakeDb(rejectWith?: { code: number }) {
      const update = vi.fn(() => {
        if (!rejectWith) return Promise.resolve();
        const err = Object.assign(new Error('boom'), rejectWith);
        return Promise.reject(err);
      });
      const set = vi.fn(() => Promise.resolve());
      const doc = vi.fn(() => ({ update, set }));
      const collection = vi.fn(() => ({ doc }));
      const db = { collection } as unknown as Parameters<typeof handle.mergeIfExists>[0];
      return { db, update, set, doc, collection };
    }

    it('writes through update() — never set() — and resolves true', async () => {
      const { db, update, set, collection, doc } = fakeDb();
      await expect(
        handle.mergeIfExists(db, { thingId: 'abc' }, 'd1', { cStat: '100' }),
      ).resolves.toBe(true);
      expect(collection).toHaveBeenCalledWith('things/abc/sub');
      expect(doc).toHaveBeenCalledWith('d1');
      expect(update).toHaveBeenCalledWith({ cStat: '100' });
      // The whole point: an absent doc must NOT be upserted.
      expect(set).not.toHaveBeenCalled();
    });

    it('resolves false (no throw, no create) when the doc is gone — gRPC NOT_FOUND', async () => {
      const { db, set } = fakeDb({ code: 5 });
      await expect(
        handle.mergeIfExists(db, { thingId: 'abc' }, 'd1', { cStat: '1' }),
      ).resolves.toBe(false);
      expect(set).not.toHaveBeenCalled();
    });

    it('rethrows any non-NOT_FOUND failure (PERMISSION_DENIED stays fatal)', async () => {
      const { db } = fakeDb({ code: 7 });
      await expect(
        handle.mergeIfExists(db, { thingId: 'abc' }, 'd1', { cStat: '1' }),
      ).rejects.toThrow('boom');
    });

    it('never injects schema defaults (same guarantee as parseMerge)', async () => {
      const { db, update } = fakeDb();
      await handle.mergeIfExists(db, { thingId: 'abc' }, 'd1', { cStat: null });
      expect(update).toHaveBeenCalledWith({ cStat: null });
    });

    it('validates the patch before writing anything', async () => {
      const { db, update } = fakeDb();
      await expect(
        handle.mergeIfExists(db, { thingId: 'abc' }, 'd1', { tpEmis: 'not-a-number' }),
      ).rejects.toThrow();
      expect(update).not.toHaveBeenCalled();
    });

    // The update()-vs-set(merge) divergence guard: both of these would write
    // something DIFFERENT from what the same patch does through merge().
    it('throws on a nested plain object (update replaces the map, merge deep-merges it)', async () => {
      const { db, update } = fakeDb();
      await expect(
        looseHandle.mergeIfExists(db, {}, 'd1', { nome: 'x', bloco: { a: 1 } }),
      ).rejects.toThrow(TypeError);
      expect(update).not.toHaveBeenCalled();
    });

    it('throws on a dotted key (update reads it as a field path, merge as a literal name)', async () => {
      const { db, update } = fakeDb();
      await expect(looseHandle.mergeIfExists(db, {}, 'd1', { 'a.b': 1 })).rejects.toThrow(
        TypeError,
      );
      expect(update).not.toHaveBeenCalled();
    });

    it('allows a class instance — Timestamp/GeoPoint/Buffer are leaf values, not maps', async () => {
      const { db, update } = fakeDb();
      class FakeTimestamp {
        constructor(readonly seconds: number) {}
      }
      const ts = new FakeTimestamp(1);
      await expect(looseHandle.mergeIfExists(db, {}, 'd1', { nome: 'x', at: ts })).resolves.toBe(
        true,
      );
      expect(update).toHaveBeenCalledWith({ nome: 'x', at: ts });
    });

    it('an empty patch writes nothing and resolves true', async () => {
      const { db, update, set } = fakeDb();
      await expect(handle.mergeIfExists(db, { thingId: 'abc' }, 'd1', {})).resolves.toBe(true);
      expect(update).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
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
