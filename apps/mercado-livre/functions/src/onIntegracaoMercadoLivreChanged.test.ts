import { beforeEach, describe, expect, it, vi } from 'vitest';

// Isolate the trigger WIRING from the sync core + the admin singleton (the core has
// its own coverage in `lib/marketplace/intFreteSync.test.ts`). Mirrors apps/whatsapp's
// `sendOutbound.test.ts` — the real `onDocumentWritten` is used, and the returned
// CloudFunction is driven through its `.run(event)` handle.
const core = vi.hoisted(() => ({
  contaRealmenteExcluida: vi.fn(async () => true),
  desativarIntFreteDaConta: vi.fn(async () => ({ action: 'desativado' })),
  sincronizarIntFreteDaConta: vi.fn(async () => ({ action: 'criado', intFreteId: 'if-1' })),
}));
vi.mock('../../lib/marketplace/intFreteSync', async () => {
  // `ehContaMercadoLivre` / `mudouCampoSincronizado` are the trigger's free gates —
  // keep them REAL so the zero-read assertions below test the actual predicate.
  const real = await vi.importActual<typeof import('../../lib/marketplace/intFreteSync')>(
    '../../lib/marketplace/intFreteSync',
  );
  return { ...real, ...core };
});

const admin = vi.hoisted(() => ({ db: { __fake: 'db' } }));
vi.mock('./lib/admin', () => ({ getDb: () => admin.db }));

const { onIntegracaoMercadoLivreChanged } = await import('./onIntegracaoMercadoLivreChanged');

const EVENT_TIME = '2026-08-04T12:00:00.000Z';
const EVENT_MS = Date.parse(EVENT_TIME);
const CONTA_ID = 'conta-A';

type Snap = { exists: boolean; data: () => Record<string, unknown> };
type RunnableEvent = {
  data: { before: Snap; after: Snap } | undefined;
  params: { integracaoId: string };
  time: string;
};

function snap(data: Record<string, unknown> | null): Snap {
  return { exists: data != null, data: () => data ?? {} };
}

function run(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const event: RunnableEvent = {
    data: { before: snap(before), after: snap(after) },
    params: { integracaoId: CONTA_ID },
    time: EVENT_TIME,
  };
  return (
    onIntegracaoMercadoLivreChanged as unknown as { run(e: RunnableEvent): Promise<unknown> }
  ).run(event);
}

const conta = (over: Record<string, unknown> = {}) => ({
  tipo: 1,
  nome: 'Loja ML',
  ativo: true,
  filialIntegracaoPedidoOuterRef: 'documents/filiais/fil-1',
  dataCadastro: 1700000000000,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  core.contaRealmenteExcluida.mockResolvedValue(true);
});

describe('onIntegracaoMercadoLivreChanged wiring', () => {
  it('binds to the named default database and the integracao path', () => {
    const endpoint = (
      onIntegracaoMercadoLivreChanged as unknown as { __endpoint: Record<string, unknown> }
    ).__endpoint;
    expect(JSON.stringify(endpoint)).toContain('integracao/{integracaoId}');
    // `database` must be set — an omitted database binds to the non-existent
    // `(default)` and the trigger never fires (root CLAUDE.md, rule 1).
    expect(JSON.stringify(endpoint)).toContain('default');
  });

  it('syncs on create, passing the named db, the after-snapshot and the EVENT time', async () => {
    const after = conta();
    await run(null, after);
    expect(core.sincronizarIntFreteDaConta).toHaveBeenCalledWith(
      admin.db,
      CONTA_ID,
      after,
      EVENT_MS,
    );
  });

  it('syncs when a mirrored field moves', async () => {
    await run(conta(), conta({ ativo: false }));
    expect(core.sincronizarIntFreteDaConta).toHaveBeenCalledOnce();
  });

  it('does nothing when no mirrored field moved (token refresh / user_id stamp)', async () => {
    await run(conta(), conta({ user_id: 999 }));
    expect(core.sincronizarIntFreteDaConta).not.toHaveBeenCalled();
    expect(core.desativarIntFreteDaConta).not.toHaveBeenCalled();
  });

  it('ignores a conta of another channel entirely', async () => {
    await run(null, { ...conta(), tipo: 6 }); // whatsapp
    expect(core.sincronizarIntFreteDaConta).not.toHaveBeenCalled();
    expect(core.desativarIntFreteDaConta).not.toHaveBeenCalled();
    expect(core.contaRealmenteExcluida).not.toHaveBeenCalled();
  });

  it('deactivates when the tipo is edited AWAY from Mercado Livre', async () => {
    await run(conta(), conta({ tipo: 5 })); // shopee
    expect(core.desativarIntFreteDaConta).toHaveBeenCalledWith(admin.db, CONTA_ID, EVENT_MS);
    expect(core.sincronizarIntFreteDaConta).not.toHaveBeenCalled();
  });

  describe('delete arm', () => {
    it('deactivates once the conta is confirmed gone', async () => {
      await run(conta(), null);
      expect(core.contaRealmenteExcluida).toHaveBeenCalledWith(admin.db, CONTA_ID);
      expect(core.desativarIntFreteDaConta).toHaveBeenCalledWith(admin.db, CONTA_ID, EVENT_MS);
    });

    it('does NOT deactivate when the conta exists again (replayed / out-of-order event)', async () => {
      core.contaRealmenteExcluida.mockResolvedValue(false);
      await run(conta(), null);
      expect(core.desativarIntFreteDaConta).not.toHaveBeenCalled();
    });

    it('ignores the delete of a non-Mercado-Livre conta without any read', async () => {
      await run({ ...conta(), tipo: 6 }, null);
      expect(core.contaRealmenteExcluida).not.toHaveBeenCalled();
      expect(core.desativarIntFreteDaConta).not.toHaveBeenCalled();
    });
  });
});
