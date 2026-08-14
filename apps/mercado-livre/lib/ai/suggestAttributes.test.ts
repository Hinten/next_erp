import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { AiAttributeSpec, AiInlineImage } from '@delfrance/integrations-mercado-livre';

import type { GenerateArgs } from '@delfrance/ai/admin';

const h = vi.hoisted(() => ({
  produto: null as Record<string, unknown> | null,
  extra: null as Record<string, unknown> | null,
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  produtoCollection: {
    docRef: () => ({ get: async () => ({ exists: h.produto != null, data: () => h.produto }) }),
    docPath: (_ctx: unknown, id: string) => `produtos/${id}`,
    parseRead: (data: unknown) => data,
  },
  produtoExtraDataCollection: {
    docRef: () => ({ get: async () => ({ exists: h.extra != null, data: () => h.extra }) }),
    docPath: () => 'produtos/p/extraData/singleton',
    parseRead: (data: unknown) => data,
  },
}));

const { ProdutoNotFoundError, suggestAttributes } = await import('./suggestAttributes');

function spec(over: Partial<AiAttributeSpec> & { id: string }): AiAttributeSpec {
  return {
    name: over.id,
    valueType: 'string',
    values: [],
    hint: null,
    valueMaxLength: null,
    defaultUnit: null,
    required: false,
    ...over,
  };
}

const ATTRS = [
  spec({ id: 'BRAND', name: 'Marca' }),
  spec({
    id: 'MATERIAL',
    valueType: 'list',
    values: [{ id: 'M1', name: 'Algodão' }],
  }),
];

/**
 * Split in two so the spread does NOT widen `generate` back to a plain
 * `GenerateFn` — the tests below read `.mock.calls` off it.
 */
function baseDeps() {
  return {
    db: {} as Firestore,
    generate: vi.fn(async (_args: GenerateArgs): Promise<unknown> => ({ BRAND: 'Hering' })),
    loadImage: vi.fn(async (): Promise<AiInlineImage | null> => null),
    loadAtributos: vi.fn(
      async (): Promise<{ leaf: boolean; atributos: AiAttributeSpec[] }> => ({
        leaf: true,
        atributos: ATTRS,
      }),
    ),
    model: 'gemini-3.5-flash-lite',
  };
}
type Deps = ReturnType<typeof baseDeps>;

function deps(over: Partial<Deps> & { signal?: AbortSignal } = {}) {
  return { ...baseDeps(), ...over };
}

beforeEach(() => {
  h.produto = { nome: 'Camiseta Básica', fotos: [] };
  h.extra = null;
});

describe('suggestAttributes', () => {
  it('returns staged suggestions and writes nothing', async () => {
    const d = deps();
    const result = await suggestAttributes(d, { produtoId: 'p1', categoryId: 'MLB31447' });
    expect(result.sugestoes).toEqual([
      { id: 'BRAND', value_id: null, value_name: 'Hering', unit_id: null },
    ]);
    expect(result.atributos).toBe(2);
  });

  it('never calls the model for a mid-tree category', async () => {
    // A non-leaf has no attributes at all — spending a billed call on an empty
    // schema would be pure waste.
    const d = deps({ loadAtributos: vi.fn(async () => ({ leaf: false, atributos: [] })) });
    const result = await suggestAttributes(d, { produtoId: 'p1', categoryId: 'MLB1430' });
    expect(result.leaf).toBe(false);
    expect(d.generate).not.toHaveBeenCalled();
  });

  it('never calls the model when the category defines no attributes', async () => {
    const d = deps({ loadAtributos: vi.fn(async () => ({ leaf: true, atributos: [] })) });
    await suggestAttributes(d, { produtoId: 'p1', categoryId: 'MLB1' });
    expect(d.generate).not.toHaveBeenCalled();
  });

  it('raises a distinct error for a missing produto, not a model failure', async () => {
    h.produto = null;
    await expect(
      suggestAttributes(deps(), { produtoId: 'ghost', categoryId: 'MLB31447' }),
    ).rejects.toBeInstanceOf(ProdutoNotFoundError);
  });

  it('sends marca and descrição from the extraData singleton', async () => {
    // Same source publish reads them from.
    h.extra = { marca: 'Hering', descricao: 'Malha 100% algodão' };
    const d = deps();
    await suggestAttributes(d, { produtoId: 'p1', categoryId: 'MLB31447' });
    const request = d.generate.mock.calls[0]![0].request;
    expect(request.text).toContain('Hering');
    expect(request.text).toContain('Malha 100% algodão');
  });

  it('runs text-only when the produto has no usable photo', async () => {
    const d = deps();
    const result = await suggestAttributes(d, { produtoId: 'p1', categoryId: 'MLB31447' });
    expect(d.generate.mock.calls[0]![0].request.image).toBeUndefined();
    expect(result.comFoto).toBe(false);
  });

  it('includes the photo when one resolves', async () => {
    const d = deps({
      loadImage: vi.fn(async () => ({ base64: 'QUJD', mimeType: 'image/jpeg' })),
    });
    const result = await suggestAttributes(d, { produtoId: 'p1', categoryId: 'MLB31447' });
    expect(d.generate.mock.calls[0]![0].request.image).toEqual({
      base64: 'QUJD',
      mimeType: 'image/jpeg',
    });
    expect(result.comFoto).toBe(true);
  });

  it('sends a schema with no `required`, at any depth', async () => {
    // The anti-hallucination guarantee has to survive the trip through here,
    // not just exist in the builder.
    const d = deps();
    await suggestAttributes(d, { produtoId: 'p1', categoryId: 'MLB31447' });
    const schema = d.generate.mock.calls[0]![0].request.responseSchema;
    expect(JSON.stringify(schema)).not.toContain('"required"');
    expect(JSON.stringify(schema)).not.toContain('"nullable"');
  });

  it('drops an answer key the category does not define', async () => {
    // The model answer is untrusted input.
    const d = deps({ generate: vi.fn(async () => ({ NOT_REAL: 'x', BRAND: 'Hering' })) });
    const result = await suggestAttributes(d, { produtoId: 'p1', categoryId: 'MLB31447' });
    expect(result.sugestoes.map((s) => s.id)).toEqual(['BRAND']);
  });

  it('survives an answer that is not an object at all', async () => {
    const d = deps({ generate: vi.fn(async () => 'desculpe, não sei') });
    const result = await suggestAttributes(d, { produtoId: 'p1', categoryId: 'MLB31447' });
    expect(result.sugestoes).toEqual([]);
  });

  it('passes the abort signal through to the model call', async () => {
    const signal = AbortSignal.timeout(1_000);
    const d = deps({ signal });
    await suggestAttributes(d, { produtoId: 'p1', categoryId: 'MLB31447' });
    expect(d.generate.mock.calls[0]![0].signal).toBe(signal);
  });
});
