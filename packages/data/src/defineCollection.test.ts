import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { docMock, collectionMock, setDocMock } = vi.hoisted(() => ({
  // `doc()` returns a raw ref; `docRef()` chains `.withConverter()` on it,
  // `merge()` must NOT — the tests below tell the two apart via `converted`.
  docMock: vi.fn((_db: unknown, path: string, id: string) => ({
    path: `${path}/${id}`,
    withConverter: vi.fn(() => ({ path: `${path}/${id}`, converted: true })),
  })),
  collectionMock: vi.fn((_db: unknown, path: string) => ({
    path,
    withConverter: vi.fn(() => ({ path, converted: true })),
  })),
  setDocMock: vi.fn((_ref: unknown, _data: unknown, _opts: unknown) => Promise.resolve()),
}));

vi.mock('firebase/firestore', () => ({
  doc: docMock,
  collection: collectionMock,
  setDoc: setDocMock,
}));

import { conversaSchema } from '@delfrance/schemas';
import { defineCollection } from './defineCollection';

const db = {} as never;

// Every field defaulted — the shape where a converted merge write is most
// destructive, because a full parse "completes" any partial patch.
const schema = z.object({
  nome: z.string().default('sem título'),
  estado: z.number().int().default(0),
  etiqueta: z.string().nullable().default(null),
});

const handle = defineCollection({ path: 'things/{thingId}/sub', schema });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('defineCollection.merge', () => {
  it('writes ONLY the supplied keys — sibling fields are never reset to schema defaults', async () => {
    await handle.merge(db, { thingId: 'abc' }, 'doc1', { estado: 2 });

    expect(setDocMock).toHaveBeenCalledTimes(1);
    const [, payload, opts] = setDocMock.mock.calls[0]!;
    // The crux: no `nome`/`etiqueta` default in the payload. With
    // `merge: true` the field-mask comes from this object, so a leaked
    // default would overwrite the stored sibling.
    expect(payload).toEqual({ estado: 2 });
    expect(opts).toEqual({ merge: true });
  });

  it('writes through the RAW doc ref, never the converted one', async () => {
    await handle.merge(db, { thingId: 'abc' }, 'doc1', { estado: 2 });

    const rawRef = docMock.mock.results[0]!.value;
    const [refPassed] = setDocMock.mock.calls[0]!;
    expect(refPassed).toBe(rawRef);
    expect((refPassed as { converted?: boolean }).converted).toBeUndefined();
    expect(rawRef.path).toBe('things/abc/sub/doc1');
  });

  it('an explicitly-undefined defaulted key is treated as not supplied — its default never enters the payload', async () => {
    // Patches built by diffing/optional spreads often carry `key: undefined`.
    // Zod's `.partial()` still runs `.default()` on those, so without the
    // undefined-strip in parseMergePatch the payload would carry
    // `nome: 'sem título'` and the merge would reset the stored nome.
    await handle.merge(db, { thingId: 'abc' }, 'doc1', { nome: undefined, estado: 2 });

    const [, payload] = setDocMock.mock.calls[0]!;
    expect(payload).toEqual({ estado: 2 });
  });

  it('validates supplied keys: wrong type and unknown key both throw', async () => {
    await expect(handle.merge(db, { thingId: 'abc' }, 'doc1', { estado: 'x' })).rejects.toThrow(
      z.ZodError,
    );
    await expect(handle.merge(db, { thingId: 'abc' }, 'doc1', { bogus: 1 })).rejects.toThrow(
      z.ZodError,
    );
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('conversa regression (#PR-C2 audit): estado change patch does not clobber nome/origem/etc.', async () => {
    // The exact write `handleEstadoChange` does on /chat/[id] and
    // /whatsapp/[id]. Through the converter this patch came back as a
    // COMPLETE Conversa (nome 'Conversa sem título', origem 'site', all
    // outer refs null, …) and the merge mask reset every stored field.
    const conversas = defineCollection({ path: 'chat', schema: conversaSchema });
    await conversas.merge(db, {}, 'conv1', {
      estadoConversa: 2,
      ultima_modificacao: 1_700_000_000_000,
    });

    const [, payload] = setDocMock.mock.calls[0]!;
    expect(payload).toEqual({ estadoConversa: 2, ultima_modificacao: 1_700_000_000_000 });
  });
});

describe('defineCollection converter (the reason merge() exists)', () => {
  it('toFirestore full-parses: a partial patch comes back with every default filled', () => {
    // Documents the footgun: this output is what `{ merge: true }` would
    // mask on — so a converted-ref merge overwrites siblings with defaults.
    const out = handle.converter.toFirestore({ estado: 2 } as never) as Record<string, unknown>;
    expect(out).toEqual({ estado: 2, nome: 'sem título', etiqueta: null });
  });
});
