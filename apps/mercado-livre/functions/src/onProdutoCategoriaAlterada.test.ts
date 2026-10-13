import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Same env stubbing as `onProdutoMercadoLivreLinkChanged.test.ts`.
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
const originalMlTasksRegion = process.env.MERCADO_LIVRE_TASKS_REGION;
process.env.FUNCTIONS_REGION = 'us-central1';
process.env.MERCADO_LIVRE_TASKS_REGION = 'us-central1';

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  process.env.MERCADO_LIVRE_TASKS_REGION = originalMlTasksRegion;
});

// `planCategoriaDoProduto` stays REAL: it is the gate that keeps a trigger on
// EVERY produto write from reading anything.
const core = vi.hoisted(() => ({ resolverAvisosDoProduto: vi.fn(async () => 1) }));
vi.mock('../../lib/marketplace/anuncios/categoriaAnuncio', async () => {
  const real = await vi.importActual<
    typeof import('../../lib/marketplace/anuncios/categoriaAnuncio')
  >('../../lib/marketplace/anuncios/categoriaAnuncio');
  return { ...real, ...core };
});

const admin = vi.hoisted(() => ({ db: { __fake: 'db' }, getDb: vi.fn() }));
admin.getDb.mockImplementation(() => admin.db);
vi.mock('./lib/admin', () => ({ getDb: admin.getDb }));

const { onProdutoCategoriaAlterada } = await import('./onProdutoCategoriaAlterada');

const PRODUTO = 'prod-1';

type Endpoint = {
  eventTrigger: {
    eventFilters: Record<string, string>;
    eventFilterPathPatterns: Record<string, string>;
    retry: boolean;
  };
};
type Snap = { exists: boolean; data: () => Record<string, unknown> };

function snap(data: Record<string, unknown> | null): Snap {
  return { exists: data != null, data: () => data ?? {} };
}

function run(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const event = {
    data: { before: snap(before), after: snap(after) },
    params: { produtoId: PRODUTO },
    time: '2026-10-08T12:00:00.000Z',
  };
  return (onProdutoCategoriaAlterada as unknown as { run(e: unknown): Promise<unknown> }).run(
    event,
  );
}

const produto = (over: Record<string, unknown> = {}) => ({
  nome: 'Camiseta',
  categoriaProdutoOuterRef: 'documents/categorias/MLB1',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  admin.getDb.mockImplementation(() => admin.db);
});

describe('onProdutoCategoriaAlterada wiring', () => {
  it('binds to the named default database and the produto path, with retry', () => {
    const { eventTrigger } = (onProdutoCategoriaAlterada as unknown as { __endpoint: Endpoint })
      .__endpoint;
    expect(eventTrigger.eventFilterPathPatterns.document).toBe('produtos/{produtoId}');
    expect(eventTrigger.eventFilters.database).toBe('default');
    expect(eventTrigger.retry).toBe(true);
  });

  it('binds NO secrets — it never calls the ML API', () => {
    const serialized = JSON.stringify(
      (onProdutoCategoriaAlterada as unknown as { __endpoint: Record<string, unknown> }).__endpoint,
    );
    expect(serialized).not.toContain('MERCADO_LIVRE_CLIENT_ID');
    expect(serialized).not.toContain('MERCADO_LIVRE_CLIENT_SECRET');
  });

  it('a changed ERP category resolves the produto’s avisos with the NEW id', async () => {
    await run(produto(), produto({ categoriaProdutoOuterRef: 'documents/categorias/MLB2' }));
    expect(core.resolverAvisosDoProduto).toHaveBeenCalledWith(admin.db, PRODUTO, 'MLB2', {
      nowMs: expect.any(Number),
    });
  });

  it('costs ZERO reads on every other produto write — it runs on all of them', async () => {
    await run(produto(), produto({ nome: 'Camiseta Nova', precos: { x: 1 } }));
    await run(produto(), produto({ categoriaProdutoOuterRef: 'categorias/MLB1' }));
    await run(null, produto());
    await run(produto(), null);
    expect(admin.getDb).not.toHaveBeenCalled();
    expect(core.resolverAvisosDoProduto).not.toHaveBeenCalled();
  });
});
