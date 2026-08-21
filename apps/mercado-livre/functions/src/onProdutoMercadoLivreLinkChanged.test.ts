import { beforeEach, describe, expect, it, vi } from 'vitest';

// Isolate the trigger WIRING from the IO core + the admin singleton (the core has
// its own coverage in `lib/marketplace/integracoesComProduto.test.ts`). Mirrors the
// sibling `onIntegracaoMercadoLivreChanged.test.ts` — the real `onDocumentWritten`
// is used, and the returned CloudFunction is driven through its `.run(event)` handle.
const core = vi.hoisted(() => ({
  adicionarConta: vi.fn(async () => true),
  removerContaSeOrfa: vi.fn(async () => true),
  sobrevivemLinksDoProduto: vi.fn(() => async () => false),
}));
vi.mock('../../lib/marketplace/anuncios/integracoesComProduto', async () => {
  // `planLinkChange` / `contaIdFromRef` are the trigger's free gates — keep them
  // REAL so the zero-read assertions below exercise the actual predicate rather
  // than a stub that would pass no matter what the trigger does.
  const real = await vi.importActual<
    typeof import('../../lib/marketplace/anuncios/integracoesComProduto')
  >('../../lib/marketplace/anuncios/integracoesComProduto');
  return { ...real, ...core };
});

const admin = vi.hoisted(() => ({ db: { __fake: 'db' }, getDb: vi.fn() }));
admin.getDb.mockImplementation(() => admin.db);
vi.mock('./lib/admin', () => ({ getDb: admin.getDb }));

const { onProdutoMercadoLivreLinkChanged } = await import('./onProdutoMercadoLivreLinkChanged');

const PRODUTO = 'prod-1';
const LINK = 'link-1';
const CONTA = 'conta-A';
const OUTRA = 'conta-B';

/** The bits of a gen2 CloudFunction's `__endpoint` these assertions read. */
type Endpoint = {
  eventTrigger: {
    eventFilters: Record<string, string>;
    eventFilterPathPatterns: Record<string, string>;
    retry: boolean;
  };
};

type Snap = { exists: boolean; data: () => Record<string, unknown> };
type RunnableEvent = {
  data: { before: Snap; after: Snap } | undefined;
  params: { produtoId: string; linkId: string };
  time: string;
};

function snap(data: Record<string, unknown> | null): Snap {
  return { exists: data != null, data: () => data ?? {} };
}

function run(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const event: RunnableEvent = {
    data: { before: snap(before), after: snap(after) },
    params: { produtoId: PRODUTO, linkId: LINK },
    time: '2026-08-10T12:00:00.000Z',
  };
  return (
    onProdutoMercadoLivreLinkChanged as unknown as { run(e: RunnableEvent): Promise<unknown> }
  ).run(event);
}

/** A published listing on CONTA — the shape that counts for membership. */
const link = (over: Record<string, unknown> = {}) => ({
  contaOuterRef: `documents/integracao/${CONTA}`,
  id: 'MLB777',
  estado: 'p',
  title: 'Camiseta',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  admin.getDb.mockImplementation(() => admin.db);
  core.sobrevivemLinksDoProduto.mockImplementation(() => async () => false);
});

describe('onProdutoMercadoLivreLinkChanged wiring', () => {
  it('binds to the named default database and the parent-link path', () => {
    const { eventTrigger } = (
      onProdutoMercadoLivreLinkChanged as unknown as { __endpoint: Endpoint }
    ).__endpoint;

    expect(eventTrigger.eventFilterPathPatterns.document).toBe(
      'produtos/{produtoId}/produtoMercadoLivre/{linkId}',
    );

    // ⚠️ This MUST be an exact-equality check on the parsed field, never a
    // `JSON.stringify(...).toContain('default')`. The serialized endpoint always
    // carries `"namespace":"(default)"`, and an OMITTED `database` defaults to
    // `"(default)"` — so a substring check passes in every case and guards
    // nothing. Verified by mutation: deleting the `database:` line left a
    // `toContain` version fully green.
    //
    // Getting this wrong is the single most expensive typo in the repo: the
    // trigger binds to a database that does not exist and simply never fires,
    // with nothing anywhere to say so (root CLAUDE.md, gotcha #8).
    expect(eventTrigger.eventFilters.database).toBe('default');
    expect(eventTrigger.retry).toBe(true);
  });

  it('binds NO secrets — it never calls the ML API (src/options.ts per-function rule)', () => {
    const serialized = JSON.stringify(
      (onProdutoMercadoLivreLinkChanged as unknown as { __endpoint: Record<string, unknown> })
        .__endpoint,
    );
    expect(serialized).not.toContain('MERCADO_LIVRE_CLIENT_ID');
    expect(serialized).not.toContain('MERCADO_LIVRE_CLIENT_SECRET');
  });

  it('adds the conta when a listing goes live, passing the named db and the event params', async () => {
    await run(null, link());
    expect(core.adicionarConta).toHaveBeenCalledWith(admin.db, PRODUTO, CONTA);
    expect(core.removerContaSeOrfa).not.toHaveBeenCalled();
  });

  it('checks the conta on a cancel, handing the survivor scan for THIS produto+conta', async () => {
    await run(link(), link({ estado: 'c' }));
    expect(core.adicionarConta).not.toHaveBeenCalled();
    expect(core.sobrevivemLinksDoProduto).toHaveBeenCalledWith(admin.db, PRODUTO, CONTA);
    expect(core.removerContaSeOrfa).toHaveBeenCalledWith(
      admin.db,
      PRODUTO,
      CONTA,
      expect.any(Function),
    );
  });

  it('checks the conta on a delete', async () => {
    await run(link(), null);
    expect(core.removerContaSeOrfa).toHaveBeenCalledWith(
      admin.db,
      PRODUTO,
      CONTA,
      expect.any(Function),
    );
    expect(core.adicionarConta).not.toHaveBeenCalled();
  });

  it('re-points a changed conta ref as remove-from-old + add-to-new', async () => {
    await run(link(), link({ contaOuterRef: `documents/integracao/${OUTRA}` }));
    expect(core.adicionarConta).toHaveBeenCalledWith(admin.db, PRODUTO, OUTRA);
    expect(core.removerContaSeOrfa).toHaveBeenCalledWith(
      admin.db,
      PRODUTO,
      CONTA,
      expect.any(Function),
    );
  });

  it('adds again when a cancelled listing is relisted (self-healing)', async () => {
    await run(link({ estado: 'c' }), link());
    expect(core.adicionarConta).toHaveBeenCalledWith(admin.db, PRODUTO, CONTA);
    expect(core.removerContaSeOrfa).not.toHaveBeenCalled();
  });

  it('costs ZERO reads and writes on a routine writeback — the load-bearing fast path', async () => {
    // Every stock-send error and price writeback merges `estado`/`errors`/
    // `ultimaModificacao` through `mergeIfExists`, so these events vastly
    // outnumber real membership changes and must not touch Firestore at all.
    await run(link(), link({ ultimaModificacao: 1_700_000_000_000, errors: ['429'] }));
    expect(admin.getDb).not.toHaveBeenCalled();
    expect(core.adicionarConta).not.toHaveBeenCalled();
    expect(core.removerContaSeOrfa).not.toHaveBeenCalled();
  });

  it('costs nothing for a draft written and rewritten (never had an ML id)', async () => {
    const draft = link({ id: null, estado: 'r' });
    await run(draft, { ...draft, sku: 'SKU-1' });
    expect(admin.getDb).not.toHaveBeenCalled();
    expect(core.adicionarConta).not.toHaveBeenCalled();
  });

  it('ignores a link whose conta ref is unresolvable rather than acting on it', async () => {
    await run(null, link({ contaOuterRef: 'documents/produtos/p1' }));
    expect(admin.getDb).not.toHaveBeenCalled();
    expect(core.adicionarConta).not.toHaveBeenCalled();
  });
});
