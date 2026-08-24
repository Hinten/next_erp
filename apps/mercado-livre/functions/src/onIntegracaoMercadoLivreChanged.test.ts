import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The trigger takes its `region:` from `./options`, the one place the
// build-time-inlined regions are validated — so a per-function literal cannot
// quietly outvote that check. Unbundled, that validation is what throws, so
// both inlined variables are stubbed before the dynamic import below and
// restored afterwards so they do not leak into this project's other files.
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
const originalMlTasksRegion = process.env.MERCADO_LIVRE_TASKS_REGION;
process.env.FUNCTIONS_REGION = 'us-central1';
process.env.MERCADO_LIVRE_TASKS_REGION = 'us-central1';

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  process.env.MERCADO_LIVRE_TASKS_REGION = originalMlTasksRegion;
});

// Isolate the trigger WIRING from the sync core + the admin singleton (the core has
// its own coverage in `lib/marketplace/frete/intFreteSync.test.ts`). Mirrors apps/whatsapp's
// `sendOutbound.test.ts` — the real `onDocumentWritten` is used, and the returned
// CloudFunction is driven through its `.run(event)` handle.
const core = vi.hoisted(() => ({
  contaRealmenteExcluida: vi.fn(async () => true),
  desativarIntFreteDaConta: vi.fn(async () => ({ action: 'desativado' })),
  sincronizarIntFreteDaConta: vi.fn(async () => ({ action: 'criado', intFreteId: 'if-1' })),
}));
vi.mock('../../lib/marketplace/frete/intFreteSync', async () => {
  // `ehContaMercadoLivre` / `mudouCampoSincronizado` are the trigger's free gates —
  // keep them REAL so the zero-read assertions below test the actual predicate.
  const real = await vi.importActual<typeof import('../../lib/marketplace/frete/intFreteSync')>(
    '../../lib/marketplace/frete/intFreteSync',
  );
  return { ...real, ...core };
});

// Same split for the #808 arm: the re-drive itself is stubbed (its own coverage
// is in `lib/marketplace/notificacoes/notificacao.test.ts`), but `userIdResolvivel` — the
// trigger's free, payload-only gate — stays REAL, so the zero-read assertions
// below exercise the actual predicate rather than a restatement of it.
const notif = vi.hoisted(() => ({
  redriveDeferredForUserId: vi.fn(async () => ({
    encontradas: 0,
    redirecionadas: 0,
    truncado: false,
  })),
}));
vi.mock('../../lib/marketplace/notificacoes/notificacao', async () => {
  const real = await vi.importActual<
    typeof import('../../lib/marketplace/notificacoes/notificacao')
  >('../../lib/marketplace/notificacoes/notificacao');
  return { ...real, ...notif };
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
    const { eventTrigger } = (
      onIntegracaoMercadoLivreChanged as unknown as {
        __endpoint: {
          eventTrigger: {
            eventFilters: Record<string, string>;
            eventFilterPathPatterns: Record<string, string>;
          };
        };
      }
    ).__endpoint;

    expect(eventTrigger.eventFilterPathPatterns.document).toBe('integracao/{integracaoId}');

    // ⚠️ Exact equality on the parsed field. This assertion USED to be
    // `expect(JSON.stringify(endpoint)).toContain('default')`, which guarded
    // nothing: the serialized endpoint always carries `"namespace":"(default)"`,
    // and an omitted `database` defaults to `"(default)"` — both contain the
    // substring, so it passed either way. Found by mutation-testing the #920
    // triggers, which were written from this file as the model.
    //
    // The bug it is meant to catch is silent and total: the trigger binds to a
    // database that does not exist and never fires (root CLAUDE.md, gotcha #8).
    expect(eventTrigger.eventFilters.database).toBe('default');
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

  it('does not sync int_frete when no mirrored field moved (token refresh / user_id stamp)', async () => {
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

  describe('deferred-notification re-drive arm (#808)', () => {
    it('re-drives when the OAuth exchange stamps user_id — the write int_frete deliberately skips', async () => {
      // This is the whole reason the arm sits ABOVE the mudouCampoSincronizado
      // gate: a `user_id` stamp moves no mirrored field, so that gate returns
      // before ever seeing it, yet it is exactly the moment the seller becomes
      // resolvable.
      await run(conta(), conta({ user_id: 999 }));
      expect(notif.redriveDeferredForUserId).toHaveBeenCalledWith(admin.db, 999);
      expect(core.sincronizarIntFreteDaConta).not.toHaveBeenCalled();
    });

    it('re-drives on create when the conta already carries a user_id (legacy corpus)', async () => {
      await run(null, conta({ user_id: 999 }));
      expect(notif.redriveDeferredForUserId).toHaveBeenCalledWith(admin.db, 999);
    });

    it('re-drives when an existing conta is re-activated', async () => {
      // `ativo` is one of the three predicates the resolve query filters on, so
      // false → true makes a seller resolvable just as a user_id stamp does.
      await run(conta({ ativo: false, user_id: 999 }), conta({ ativo: true, user_id: 999 }));
      expect(notif.redriveDeferredForUserId).toHaveBeenCalledWith(admin.db, 999);
    });

    it('does NOT re-drive when the seller was already resolvable (replay / unrelated edit)', async () => {
      await run(conta({ user_id: 999 }), conta({ user_id: 999, nome: 'Outro nome' }));
      expect(notif.redriveDeferredForUserId).not.toHaveBeenCalled();
    });

    it('does NOT re-drive a deactivation, a token refresh, or a conta with no user_id', async () => {
      await run(conta({ ativo: true, user_id: 999 }), conta({ ativo: false, user_id: 999 }));
      await run(conta(), conta({ nome: 'Renomeada' }));
      expect(notif.redriveDeferredForUserId).not.toHaveBeenCalled();
    });

    it('costs zero reads for another channel’s conta', async () => {
      await run({ ...conta(), tipo: 6 }, { ...conta(), tipo: 6, user_id: 999 });
      expect(notif.redriveDeferredForUserId).not.toHaveBeenCalled();
    });

    it('a re-drive failure does NOT cost the int_frete sync — it runs LAST for this reason', async () => {
      // The re-drive is a latency cut the daily deferred sweep already backstops;
      // the int_frete sync has no comparable backstop. Ordering — not a catch —
      // is what stops the cheap work short-circuiting the load-bearing work, so
      // hoisting the arm back above the sync must fail here.
      notif.redriveDeferredForUserId.mockRejectedValueOnce(new Error('firestore unavailable'));

      // `ativo` false→true moves a MIRRORED field (so the sync runs) AND makes the
      // seller resolvable (so the re-drive runs) — the one transition that puts
      // both arms in play, which is what makes the ordering observable.
      // ⚠️ The queued rejection MUST be consumed here: `vi.clearAllMocks()` in
      // `beforeEach` does not drain a `mockRejectedValueOnce`, so a case that
      // never invokes the mock leaks the rejection into the next test.
      await expect(
        run(conta({ ativo: false, user_id: 999 }), conta({ ativo: true, user_id: 999 })),
      ).rejects.toThrow('firestore unavailable');

      // ...and the sync still happened, before the throw.
      expect(core.sincronizarIntFreteDaConta).toHaveBeenCalledOnce();
    });

    it('still re-drives for a write the int_frete gate skips (the whole point of the gate being positive)', async () => {
      // A bare `user_id` stamp moves no mirrored field, so the sync is skipped —
      // but this is exactly the write the #808 arm exists for. An early `return`
      // in the sync gate would swallow it.
      await run(conta(), conta({ user_id: 999 }));
      expect(core.sincronizarIntFreteDaConta).not.toHaveBeenCalled();
      expect(notif.redriveDeferredForUserId).toHaveBeenCalledWith(admin.db, 999);
    });
  });
});
