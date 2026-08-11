import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same split as the sibling wiring tests: the IO core is stubbed (covered by
// `lib/marketplace/integracoesComProduto.test.ts`), the pure gates stay REAL, and
// the CloudFunction is driven through `.run(event)`.
//
// `lerLinkPai` is the ONE IO seam left real-adjacent: it is stubbed to a canned
// reader so `resolverContaRefDaVariacao` — the orchestration this trigger is
// actually responsible for — runs for real, including the transitional fallback
// hop for rows that predate `contaOuterRef`.
const paiReader = vi.hoisted(() => ({
  fn: vi.fn(async (_pai: { produtoId: string; linkId: string }) => null as unknown),
}));
const core = vi.hoisted(() => ({
  adicionarConta: vi.fn(async () => true),
  removerContaSeOrfa: vi.fn(async () => true),
  sobrevivemVariacoesDoProduto: vi.fn(() => async () => false),
}));
vi.mock('../../lib/marketplace/integracoesComProduto', async () => {
  const real = await vi.importActual<typeof import('../../lib/marketplace/integracoesComProduto')>(
    '../../lib/marketplace/integracoesComProduto',
  );
  return { ...real, ...core, lerLinkPai: () => paiReader.fn };
});

const admin = vi.hoisted(() => ({ db: { __fake: 'db' }, getDb: vi.fn() }));
admin.getDb.mockImplementation(() => admin.db);
vi.mock('./lib/admin', () => ({ getDb: admin.getDb }));

const { onVariacaoMercadoLivreLinkChanged } = await import('./onVariacaoMercadoLivreLinkChanged');

const CHILD = 'child-1';
const DOC = 'var-1';
const CONTA = 'conta-A';
const PML_REF = 'documents/produtos/prod-1/produtoMercadoLivre/link-1';

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
  params: { produtoId: string; docId: string };
  time: string;
};

function snap(data: Record<string, unknown> | null): Snap {
  return { exists: data != null, data: () => data ?? {} };
}

function run(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const event: RunnableEvent = {
    data: { before: snap(before), after: snap(after) },
    params: { produtoId: CHILD, docId: DOC },
    time: '2026-08-10T12:00:00.000Z',
  };
  return (
    onVariacaoMercadoLivreLinkChanged as unknown as { run(e: RunnableEvent): Promise<unknown> }
  ).run(event);
}

/** A variation link written since #920 — carries its own conta. */
const link = (over: Record<string, unknown> = {}) => ({
  contaOuterRef: `documents/integracao/${CONTA}`,
  produtoMercadoLivreOuterRef: PML_REF,
  id: 555,
  sku: 'SKU-M',
  ...over,
});

/** The pre-#920 wire shape: no `contaOuterRef`, conta only via the parent link. */
const linkLegado = (over: Record<string, unknown> = {}) => ({
  produtoMercadoLivreOuterRef: PML_REF,
  id: 555,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  admin.getDb.mockImplementation(() => admin.db);
  core.sobrevivemVariacoesDoProduto.mockImplementation(() => async () => false);
  paiReader.fn.mockResolvedValue(null);
});

describe('onVariacaoMercadoLivreLinkChanged wiring', () => {
  it('binds to the named default database and the variation-link path', () => {
    const { eventTrigger } = (
      onVariacaoMercadoLivreLinkChanged as unknown as { __endpoint: Endpoint }
    ).__endpoint;

    expect(eventTrigger.eventFilterPathPatterns.document).toBe(
      'produtos/{produtoId}/variacaoMercadoLivre/{docId}',
    );
    // Exact equality, not a substring of the serialized endpoint — see the note
    // on the sibling assertion in `onProdutoMercadoLivreLinkChanged.test.ts`:
    // `"namespace":"(default)"` makes any `toContain('default')` vacuous.
    expect(eventTrigger.eventFilters.database).toBe('default');
    expect(eventTrigger.retry).toBe(true);
  });

  it('binds NO secrets — it never calls the ML API', () => {
    const serialized = JSON.stringify(
      (onVariacaoMercadoLivreLinkChanged as unknown as { __endpoint: Record<string, unknown> })
        .__endpoint,
    );
    expect(serialized).not.toContain('MERCADO_LIVRE_CLIENT_ID');
  });

  it('adds the conta from the link’s OWN field, without dereferencing the parent link', async () => {
    await run(null, link());
    expect(core.adicionarConta).toHaveBeenCalledWith(admin.db, CHILD, CONTA);
    // The whole point of #920 adding `contaOuterRef`: no second read.
    expect(paiReader.fn).not.toHaveBeenCalled();
  });

  it('falls back to the parent link for a row that predates contaOuterRef', async () => {
    paiReader.fn.mockResolvedValue({ contaOuterRef: `documents/integracao/${CONTA}` });
    await run(null, linkLegado());
    expect(paiReader.fn).toHaveBeenCalledWith({ produtoId: 'prod-1', linkId: 'link-1' });
    expect(core.adicionarConta).toHaveBeenCalledWith(admin.db, CHILD, CONTA);
  });

  it('does NOTHING when the parent link is already gone — leaving the entry is the safe direction', async () => {
    // `pruneMigratedSource` deletes the parent link and its variation links in ONE
    // batch, so this is the normal case, not an edge case. An unresolvable conta
    // must never be guessed at: a stale entry costs one skipped sweep row, a wrong
    // removal is a silent stock + price outage.
    paiReader.fn.mockResolvedValue(null);
    await run(linkLegado(), null);
    expect(core.adicionarConta).not.toHaveBeenCalled();
    expect(core.removerContaSeOrfa).not.toHaveBeenCalled();
  });

  it('checks the conta on a delete, handing the survivor scan for THIS child+conta', async () => {
    await run(link(), null);
    expect(core.sobrevivemVariacoesDoProduto).toHaveBeenCalledWith(admin.db, CHILD, CONTA);
    expect(core.removerContaSeOrfa).toHaveBeenCalledWith(
      admin.db,
      CHILD,
      CONTA,
      expect.any(Function),
    );
    expect(core.adicionarConta).not.toHaveBeenCalled();
  });

  it('adds when the link gains an ML identifier', async () => {
    await run(link({ id: null, itemId: null }), link({ id: null, itemId: 'MLB9' }));
    expect(core.adicionarConta).toHaveBeenCalledWith(admin.db, CHILD, CONTA);
  });

  it('costs ZERO reads and writes on a routine writeback — the fast path', async () => {
    await run(link(), link({ sku: 'SKU-G', attributes: [] }));
    expect(admin.getDb).not.toHaveBeenCalled();
    expect(paiReader.fn).not.toHaveBeenCalled();
    expect(core.adicionarConta).not.toHaveBeenCalled();
    expect(core.removerContaSeOrfa).not.toHaveBeenCalled();
  });

  it('re-points a changed conta ref as remove-from-old + add-to-new', async () => {
    await run(link(), link({ contaOuterRef: 'documents/integracao/conta-B' }));
    expect(core.adicionarConta).toHaveBeenCalledWith(admin.db, CHILD, 'conta-B');
    expect(core.removerContaSeOrfa).toHaveBeenCalledWith(
      admin.db,
      CHILD,
      CONTA,
      expect.any(Function),
    );
  });
});
