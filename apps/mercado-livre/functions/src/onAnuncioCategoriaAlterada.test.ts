import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Same env stubbing as `onProdutoMercadoLivreLinkChanged.test.ts`: the trigger
// takes its `region:` from `./options`, whose build-time validation throws when
// unbundled.
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
const originalMlTasksRegion = process.env.MERCADO_LIVRE_TASKS_REGION;
process.env.FUNCTIONS_REGION = 'us-central1';
process.env.MERCADO_LIVRE_TASKS_REGION = 'us-central1';

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  process.env.MERCADO_LIVRE_TASKS_REGION = originalMlTasksRegion;
});

// Isolate the WIRING from the IO core (covered in `categoriaAnuncio.test.ts`).
// `planCategoriaDoLink` stays REAL — it is the trigger's free gate, and the
// zero-read assertions below must exercise the actual predicate.
const core = vi.hoisted(() => ({
  aplicarPlanoCategoriaDoLink: vi.fn(async () => ({ acao: 'avisado', resultado: 'criado' })),
}));
vi.mock('../../lib/marketplace/anuncios/categoriaAnuncio', async () => {
  const real = await vi.importActual<
    typeof import('../../lib/marketplace/anuncios/categoriaAnuncio')
  >('../../lib/marketplace/anuncios/categoriaAnuncio');
  return { ...real, ...core };
});

const admin = vi.hoisted(() => ({ db: { __fake: 'db' }, getDb: vi.fn() }));
admin.getDb.mockImplementation(() => admin.db);
vi.mock('./lib/admin', () => ({ getDb: admin.getDb }));

const { onAnuncioCategoriaAlterada } = await import('./onAnuncioCategoriaAlterada');

const PRODUTO = 'prod-1';
const LINK = 'link-1';
const CONTA = 'conta-A';

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
    params: { produtoId: PRODUTO, linkId: LINK },
    time: '2026-10-08T12:00:00.000Z',
  };
  return (onAnuncioCategoriaAlterada as unknown as { run(e: unknown): Promise<unknown> }).run(
    event,
  );
}

const link = (over: Record<string, unknown> = {}) => ({
  contaOuterRef: `documents/integracao/${CONTA}`,
  id: 'MLB777',
  estado: 'p',
  title: 'Camiseta',
  category_id: 'MLB1',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  admin.getDb.mockImplementation(() => admin.db);
});

describe('onAnuncioCategoriaAlterada wiring', () => {
  it('binds to the named default database and the parent-link path, with retry', () => {
    const { eventTrigger } = (onAnuncioCategoriaAlterada as unknown as { __endpoint: Endpoint })
      .__endpoint;
    expect(eventTrigger.eventFilterPathPatterns.document).toBe(
      'produtos/{produtoId}/produtoMercadoLivre/{linkId}',
    );
    // Exact equality on the parsed field — see the sibling test for why a
    // substring check on the serialized endpoint guards nothing.
    expect(eventTrigger.eventFilters.database).toBe('default');
    expect(eventTrigger.retry).toBe(true);
  });

  it('binds BOTH ML secrets — its raise reads the new category and the fee preview', () => {
    const serialized = JSON.stringify(
      (onAnuncioCategoriaAlterada as unknown as { __endpoint: Record<string, unknown> }).__endpoint,
    );
    expect(serialized).toContain('MERCADO_LIVRE_CLIENT_ID');
    expect(serialized).toContain('MERCADO_LIVRE_CLIENT_SECRET');
  });

  it('a recategorization hands the core the plan, the named db and the event params', async () => {
    await run(link(), link({ category_id: 'MLB2' }));
    expect(core.aplicarPlanoCategoriaDoLink).toHaveBeenCalledWith(
      admin.db,
      { produtoId: PRODUTO, linkDocId: LINK },
      { tipo: 'categoria', integracaoId: CONTA, anuncio: 'MLB777', anterior: 'MLB1', nova: 'MLB2' },
      expect.objectContaining({
        nowMs: expect.any(Number),
        increment: expect.any(Function),
        resolverApi: expect.any(Function),
      }),
    );
  });

  it('a listing going not-live hands the core a `fim` plan', async () => {
    await run(link(), link({ estado: 'c' }));
    expect(core.aplicarPlanoCategoriaDoLink).toHaveBeenCalledWith(
      admin.db,
      { produtoId: PRODUTO, linkDocId: LINK },
      { tipo: 'fim', integracaoId: CONTA, motivo: 'anuncio-encerrado' },
      expect.anything(),
    );
  });

  it('costs ZERO reads on a routine writeback — the load-bearing fast path', async () => {
    await run(link(), link({ ultimaModificacao: 1_700_000_000_000, errors: ['429'] }));
    expect(admin.getDb).not.toHaveBeenCalled();
    expect(core.aplicarPlanoCategoriaDoLink).not.toHaveBeenCalled();
  });

  it('costs nothing for the first publish (a category on a NEW listing is not a move)', async () => {
    await run(link({ id: null }), link({ category_id: 'MLB2' }));
    expect(admin.getDb).not.toHaveBeenCalled();
  });
});
