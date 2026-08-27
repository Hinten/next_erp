import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreError, MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

import {
  MANUAL_PUSH_MAX_ATTEMPTS,
  ManualPushGuardError,
  enviarEstoqueManual,
  manualPushConcurrency,
  resolverAnchors,
  toPushOutcome,
} from './estoqueManual';
import {
  STOCK_MULTIORIGEM_FLAG_ENV,
  STOCK_SEND_MAX_ATTEMPTS,
  type StockFamilyRow,
} from './bulkEstoquePlan';
import type { StockSendResult } from './estoqueSend';

vi.mock('../anuncios/itemsStatusSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../anuncios/itemsStatusSync')>();
  return {
    ...actual,
    applyItemStatusToLink: vi.fn().mockResolvedValue(true),
    // The PERSISTENCE half of a família re-check. Stubbed at the same seam
    // `reverificarAnuncio.test.ts` uses — the fold is covered end-to-end against
    // a real FakeDb in `itemsStatusSync.test.ts`, and what these tests own is
    // what the manual push does with the reading it gets back (#1142).
    applyFamilyStatusAndFold: vi.fn().mockResolvedValue({
      outcome: 'synced-family',
      estado: 'p',
      status: 'active',
      subStatus: [],
    }),
  };
});

const CONTA = 'conta-1';
const CONTA_DOC = { depositoOuterRef: 'documents/depositos/DEP1', nome: 'Loja ML' };

/* --------------------------------- fixtures -------------------------------- */

/**
 * Minimal fake Firestore: `resolverAnchors` only needs docRef + getAll.
 *
 * `collectionGroup` answers with `membros` — EMPTY by default, which is the "not
 * a User-Products family" shape every single-listing fixture here needs, since
 * `reverificarAnuncio` decides between its two paths by asking for member links
 * first (#1142). Pass rows to reach the family branch.
 */
function fakeDb(
  docs: Record<string, Record<string, unknown> | null>,
  membros: Array<{ docId: string; child: string; data: Record<string, unknown> }> = [],
): Firestore {
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({ id, path: `${name}/${id}`, __id: id }),
    }),
    collectionGroup: () => ({
      where: () => ({
        get: async () => ({
          docs: membros.map((m) => ({
            id: m.docId,
            data: () => m.data,
            ref: { parent: { parent: { id: m.child } } },
          })),
        }),
      }),
    }),
    getAll: (...args: unknown[]) => {
      const refs = args.filter(
        (a): a is { __id: string } => a != null && typeof a === 'object' && '__id' in a,
      );
      return Promise.resolve(
        refs.map((ref) => {
          const data = docs[ref.__id];
          return {
            exists: data != null,
            data: () => data ?? undefined,
          };
        }),
      );
    },
  };
  return db as unknown as Firestore;
}

/**
 * ⚠️ `anchorId` and `anchor.produtoId` must agree: `buildSendTasks` keys the
 * quantity map off `anchor.produtoId` but looks it up by `anchorId`, so a
 * fixture where they diverge silently yields a `kit-virtual` skip instead of a
 * task — which reads as a bug in the code under test rather than in the fixture.
 */
function familyRow(over: Partial<StockFamilyRow> = {}): StockFamilyRow {
  const anchorId = over.anchorId ?? 'PROD';
  return {
    anchorId,
    anchor: {
      produtoId: anchorId,
      ehKit: false,
      ehKitVirtual: false,
      publicado: true,
      componentesKit: null,
      timestampMs: null,
      estoque: { quantidade: 7, quantidadeReservada: 0 },
      componentEstoques: [],
      ...over.anchor,
    },
    integracoesComProduto: [CONTA],
    links: [
      {
        id: 'MLB111',
        linkDocId: 'link1',
        estado: 'p',
        status: 'active',
        sub_status: [],
        isUserProductModel: false,
      },
    ],
    children: [],
    ...over,
  };
}

function baseDeps(over: Record<string, unknown> = {}) {
  return {
    nowMs: 1_700_000_000_000,
    conta: CONTA_DOC as Record<string, unknown>,
    contaNome: 'Loja ML',
    contextLoader: vi.fn().mockResolvedValue({
      conta: CONTA_DOC,
      resolveChannelContext: () => Promise.resolve({ accessToken: 'tok' }),
    }),
    // The full surface `reverificarAnuncio` may reach, so an override that adds
    // one of them still types. `getLastModeration` answers "none" and
    // `getItemsByIds` is never reached on the single-listing path (the fake db's
    // `collectionGroup` is empty unless a fixture says otherwise).
    api: {
      getItem: vi.fn(),
      getMe: vi.fn().mockResolvedValue({ id: 1, tags: [] }),
      getLastModeration: vi.fn().mockResolvedValue([]),
      getItemsByIds: vi.fn().mockResolvedValue([]),
    },
    fetchFamilies: vi.fn().mockResolvedValue([familyRow()]),
    sleep: vi.fn().mockResolvedValue(undefined),
    sendTask: vi.fn().mockResolvedValue({ outcome: 'sent', reason: null } as StockSendResult),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------- tunables --------------------------------- */

describe('manualPushConcurrency', () => {
  const setEnv = (manual: string | undefined, queue: string) => {
    if (manual === undefined) delete process.env.MERCADO_LIVRE_STOCK_MANUAL_CONCURRENCY;
    else process.env.MERCADO_LIVRE_STOCK_MANUAL_CONCURRENCY = manual;
    process.env.MERCADO_LIVRE_STOCK_CONCURRENT_DISPATCHES = queue;
  };

  afterEach(() => {
    delete process.env.MERCADO_LIVRE_STOCK_MANUAL_CONCURRENCY;
    delete process.env.MERCADO_LIVRE_STOCK_CONCURRENT_DISPATCHES;
  });

  it('defaults to the deployed queue concurrency', () => {
    setEnv(undefined, '3');
    expect(manualPushConcurrency()).toBe(3);
  });

  /**
   * The clamp is the point: a burst wider than the deployed queue earns a 429,
   * which stamps `pausedUntilUs` and breaks the unattended SWEEP for the whole
   * conta. A misconfigured env var must not be able to cause that.
   */
  it('CLAMPS above the queue, so a misconfigured env cannot 429 the conta', () => {
    setEnv('50', '2');
    expect(manualPushConcurrency()).toBe(2);
  });

  it('honours a value below the queue, and never returns 0', () => {
    setEnv('1', '4');
    expect(manualPushConcurrency()).toBe(1);
    setEnv('0', '4');
    expect(manualPushConcurrency()).toBe(1); // 0 would deadlock the pool
  });
});

/* ------------------------------- toPushOutcome ------------------------------ */

describe('toPushOutcome — the channel-neutral mapping', () => {
  it.each([
    [{ outcome: 'sent', reason: null }, 'enviado', null],
    [{ outcome: 'skipped', reason: 'sem-deposito' }, 'pulado', 'sem-deposito'],
    // Queue-SUCCESS but operator-FAILURE: the state was recorded so the queue
    // stops retrying, but the quantity the operator asked for never reached ML.
    [{ outcome: 'erro-registrado', reason: 'payload-rejeitado' }, 'falha', 'payload-rejeitado'],
    // The rejecting scheduler's signature: a live pause, not a coding bug.
    [{ outcome: 'dropped', reason: 'tasks-desabilitadas' }, 'nao-tentado', 'conta-pausada'],
    [{ outcome: 'dropped', reason: 'payload-invalido' }, 'falha', 'payload-invalido'],
    [{ outcome: 'paused-requeued', reason: null }, 'nao-tentado', 'conta-pausada'],
  ] as const)('%o → %s', (result, outcome, motivo) => {
    expect(toPushOutcome(result as StockSendResult)).toEqual({ outcome, motivo });
  });
});

/* ------------------------------ resolverAnchors ----------------------------- */

describe('resolverAnchors', () => {
  it('maps a variation child to its parent and dedupes with the parent', async () => {
    const db = fakeDb({
      PROD: { paiId: null, nome: 'Camiseta' },
      CH1: { paiId: 'PROD', nome: 'Camiseta P' },
    });
    const res = await resolverAnchors(db, ['CH1', 'PROD']);
    expect(res.anchorIds).toEqual(['PROD']);
    expect(res.anchorPorProdutoId.get('CH1')).toBe('PROD');
    expect(res.naoEncontrados).toEqual([]);
  });

  it('reports a missing produto instead of silently dropping it', async () => {
    // `documents([...])` SILENTLY OMITS a missing doc, so the pipeline alone
    // could never tell "does not exist" from "is not an anchor". This pass is
    // the only place that distinction is available.
    const db = fakeDb({ PROD: { paiId: null, nome: 'Camiseta' }, SUMIU: null });
    const res = await resolverAnchors(db, ['PROD', 'SUMIU']);
    expect(res.anchorIds).toEqual(['PROD']);
    expect(res.naoEncontrados).toEqual(['SUMIU']);
  });
});

/* ---------------------------------- guards ---------------------------------- */

describe('enviarEstoqueManual — conta guards', () => {
  it('refuses a conta with no depósito before any ML call', async () => {
    const deps = baseDeps({ conta: { nome: 'Loja' } });
    await expect(
      enviarEstoqueManual(fakeDb({}), { integracaoId: CONTA, produtoIds: ['PROD'] }, deps as never),
    ).rejects.toMatchObject({ code: 'ML_CONTA_SEM_DEPOSITO' });
    expect(deps.api.getMe).not.toHaveBeenCalled();
  });

  it('refuses a multiorigin conta while the flag is off — ML SILENTLY IGNORES stock PUTs there', async () => {
    // Without this probe the button would report a confident "enviado" for a
    // call ML dropped on the floor — the worst outcome for a trust feature.
    const deps = baseDeps({
      api: {
        getItem: vi.fn(),
        getMe: vi.fn().mockResolvedValue({ tags: ['warehouse_management'] }),
      },
    });
    await expect(
      enviarEstoqueManual(
        fakeDb({ PROD: { paiId: null } }),
        { integracaoId: CONTA, produtoIds: ['PROD'] },
        deps as never,
      ),
    ).rejects.toBeInstanceOf(ManualPushGuardError);
    expect(deps.sendTask).not.toHaveBeenCalled();
  });

  it('#706: with the flag on, a single-depósito multiorigin conta SENDS through seller_warehouse', async () => {
    process.env[STOCK_MULTIORIGEM_FLAG_ENV] = '1';
    const deps = baseDeps({
      api: {
        getItem: vi.fn(),
        getMe: vi.fn().mockResolvedValue({ id: 1, tags: ['normal', 'warehouse_management'] }),
      },
    });

    const res = await enviarEstoqueManual(
      fakeDb({ PROD: { paiId: null, nome: 'Camiseta' } }),
      { integracaoId: CONTA, produtoIds: ['PROD'] },
      deps as never,
    );

    expect(res.listings.length + res.produtosSemEnvio.length).toBeGreaterThan(0);
    expect(deps.sendTask).toHaveBeenCalled();
    const task = deps.sendTask.mock.calls[0]![1] as { kind: string };
    expect(task.kind).toBe('userProductStock');
  });

  it.each([
    ['skipped', 'estoque-full-gerenciado-pelo-ml', 'Fulfillment'],
    ['erro-registrado', 'sem-deposito-no-ml', 'painel do ML'],
    ['erro-registrado', 'sem-x-version', 'Reverificar anúncio'],
    ['erro-registrado', 'sem-user-product', 'User Products'],
    ['erro-registrado', 'multi-deposito-nao-suportado', 'mais de um depósito'],
    ['erro-registrado', 'deposito-sem-identificadores', 'store_id'],
  ])(
    '#706: the %s outcome %s reaches the operator with its own message, not the fallback',
    async (outcome, reason, trecho) => {
      // The handler's `reason` rides `toPushOutcome` straight into `motivo`, and
      // `mensagemDe` looks it up. A reason with no entry silently degrades to
      // "Não enviado.", which is exactly what this surface exists to avoid.
      process.env[STOCK_MULTIORIGEM_FLAG_ENV] = '1';
      const deps = baseDeps({
        api: {
          getItem: vi.fn(),
          getMe: vi.fn().mockResolvedValue({ id: 1, tags: ['warehouse_management'] }),
        },
        sendTask: vi.fn().mockResolvedValue({ outcome, reason } as StockSendResult),
      });

      const res = await enviarEstoqueManual(
        fakeDb({ PROD: { paiId: null, nome: 'Camiseta' } }),
        { integracaoId: CONTA, produtoIds: ['PROD'] },
        deps as never,
      );

      const listing = res.listings[0]!;
      expect(listing.motivo).toBe(reason);
      expect(listing.mensagem).toContain(trecho);
      expect(listing.mensagem).not.toBe('Não enviado.');
    },
  );

  it('#706: multiwarehouse keeps refusing even with the flag on, naming the mapping gap', async () => {
    process.env[STOCK_MULTIORIGEM_FLAG_ENV] = '1';
    const deps = baseDeps({
      api: {
        getItem: vi.fn(),
        getMe: vi
          .fn()
          .mockResolvedValue({ id: 1, tags: ['warehouse_management', 'multiwarehouse'] }),
      },
    });

    const err = await enviarEstoqueManual(
      fakeDb({ PROD: { paiId: null } }),
      { integracaoId: CONTA, produtoIds: ['PROD'] },
      deps as never,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ManualPushGuardError);
    expect((err as ManualPushGuardError).message).toContain('múltiplos depósitos');
    expect(deps.sendTask).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  // #706 — the multiorigem flag is per-test opt-in; leaking it would silently
  // change the routing of every spec that follows.
  delete process.env[STOCK_MULTIORIGEM_FLAG_ENV];
});

/* ---------------------------------- the run --------------------------------- */

describe('enviarEstoqueManual — sending', () => {
  const db = () => fakeDb({ PROD: { paiId: null, nome: 'Camiseta' } });

  it('sends and reports the listing with its quantity', async () => {
    const deps = baseDeps();
    const res = await enviarEstoqueManual(
      db(),
      { integracaoId: CONTA, produtoIds: ['PROD'] },
      deps as never,
    );
    expect(res.resumo).toMatchObject({ enviados: 1, falhas: 0, naoTentados: 0 });
    expect(res.listings[0]).toMatchObject({
      produtoId: 'PROD',
      produtoNome: 'Camiseta',
      anuncioId: 'MLB111',
      linkDocId: 'link1',
      outcome: 'enviado',
      quantidade: 7,
    });
  });

  it('never runs a ledger pre-pass — a manual push is force-send', async () => {
    const deps = baseDeps();
    await enviarEstoqueManual(db(), { integracaoId: CONTA, produtoIds: ['PROD'] }, deps as never);
    // The by-ids fetcher takes no window at all; if a `changedSinceMs` ever
    // appears here someone has re-introduced the sweep's change detection.
    expect(deps.fetchFamilies).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ integracaoId: CONTA, depositoId: 'DEP1', anchorIds: ['PROD'] }),
    );
    expect(deps.fetchFamilies.mock.calls[0]![1]).not.toHaveProperty('changedSinceMs');
  });

  /**
   * #781's rule, and the single most important assertion in this file: ONE 4xx
   * from ML is evidence, not proof. The ladder must retry before letting the
   * handler verify-and-record, or a transient blip latches the listing.
   */
  it('a transient 4xx that succeeds on retry sends, and NEVER latches', async () => {
    const sendTask = vi
      .fn()
      .mockRejectedValueOnce(new MercadoLivreHttpError('bad request', 400, null))
      .mockResolvedValueOnce({ outcome: 'sent', reason: null });
    const deps = baseDeps({ sendTask });
    const res = await enviarEstoqueManual(
      db(),
      { integracaoId: CONTA, produtoIds: ['PROD'] },
      deps as never,
    );
    expect(res.listings[0]!.outcome).toBe('enviado');
    // Attempt 0 must NOT be allowed to reach the terminal branch; only the last
    // attempt maps onto STOCK_SEND_MAX_ATTEMPTS - 1.
    const retryCounts = sendTask.mock.calls.map((c) => (c[2] as { retryCount: number }).retryCount);
    expect(retryCounts).toEqual([0, STOCK_SEND_MAX_ATTEMPTS - 1]);
    expect(sendTask).toHaveBeenCalledTimes(MANUAL_PUSH_MAX_ATTEMPTS);
  });

  it('bypasses the sweep master flag — the manual push works before the cutover', async () => {
    const deps = baseDeps();
    await enviarEstoqueManual(db(), { integracaoId: CONTA, produtoIds: ['PROD'] }, deps as never);
    expect(deps.sendTask.mock.calls[0]![2]).toMatchObject({ ignoreSyncFlag: true });
  });

  it('a 429 aborts the run — no retry, and the rest is reported nao-tentado', async () => {
    // Retrying inline would only re-enter the pause gate, and hammering a
    // rate-limited conta is the one thing this must never do.
    const rows = [familyRow(), familyRow({ anchorId: 'PROD2' })];
    const sendTask = vi
      .fn()
      .mockRejectedValue(new MercadoLivreHttpError('slow down', 429, null, 60));
    const deps = baseDeps({ sendTask, fetchFamilies: vi.fn().mockResolvedValue(rows) });
    const res = await enviarEstoqueManual(
      fakeDb({ PROD: { paiId: null }, PROD2: { paiId: null } }),
      { integracaoId: CONTA, produtoIds: ['PROD', 'PROD2'] },
      deps as never,
    );
    // The invariants that matter, stated so they hold whatever order the pool
    // happens to interleave in: a 429 is never RETRIED (that would re-enter the
    // pause gate and hammer a rate-limited conta), the pause window is
    // surfaced, and nothing is reported as sent.
    expect(sendTask.mock.calls.length).toBeLessThanOrEqual(rows.length);
    expect(res.pausadoAte).not.toBeNull();
    expect(res.listings.some((l) => l.outcome === 'nao-tentado')).toBe(true);
    expect(res.listings.some((l) => l.outcome === 'enviado')).toBe(false);
    expect(res.resumo.enviados).toBe(0);
  });

  it('a channel error fails ONE listing and lets the others run', async () => {
    const rows = [familyRow(), familyRow({ anchorId: 'PROD2' })];
    // Key the failure on the TASK, not on call order: the pool runs listings
    // concurrently, so `mockRejectedValueOnce` would land on whichever call got
    // there first and the test would assert nothing stable.
    const sendTask = vi
      .fn()
      .mockImplementation((_db, task: { produtoId: string }) =>
        task.produtoId === 'PROD'
          ? Promise.reject(new MercadoLivreError('boom'))
          : Promise.resolve({ outcome: 'sent', reason: null }),
      );
    const deps = baseDeps({ sendTask, fetchFamilies: vi.fn().mockResolvedValue(rows) });
    const res = await enviarEstoqueManual(
      fakeDb({ PROD: { paiId: null }, PROD2: { paiId: null } }),
      { integracaoId: CONTA, produtoIds: ['PROD', 'PROD2'] },
      deps as never,
    );
    expect(res.resumo.falhas).toBe(1);
    expect(res.resumo.enviados).toBe(1);
  });
});

/* ----------------------------------- latch ---------------------------------- */

describe('enviarEstoqueManual — the #781 latch', () => {
  const latched = () =>
    familyRow({ links: [{ id: 'MLB111', linkDocId: 'link1', estado: 'E', status: 'active' }] });

  it('without the opt-in, a latched listing is skipped and SAYS WHY', async () => {
    const deps = baseDeps({ fetchFamilies: vi.fn().mockResolvedValue([latched()]) });
    const res = await enviarEstoqueManual(
      fakeDb({ PROD: { paiId: null } }),
      { integracaoId: CONTA, produtoIds: ['PROD'] },
      deps as never,
    );
    const row = res.listings[0]!;
    expect(row).toMatchObject({
      outcome: 'pulado',
      motivo: 'anuncio-em-erro',
      anuncioId: 'MLB111',
    });
    // The operator has to be able to act on it: name the cause AND the remedy.
    expect(row.mensagem).toContain('Reenviar anúncios com erro');
    // And it must cost NOTHING extra when not asked for.
    expect(deps.api.getItem).not.toHaveBeenCalled();
    expect(deps.sendTask).not.toHaveBeenCalled();
  });

  it('with the opt-in, it re-verifies against ML and then sends', async () => {
    const deps = baseDeps({
      fetchFamilies: vi.fn().mockResolvedValue([latched()]),
      api: {
        getMe: vi.fn().mockResolvedValue({ tags: [] }),
        getItem: vi.fn().mockResolvedValue({ id: 'MLB111', status: 'active', sub_status: [] }),
      },
    });
    const res = await enviarEstoqueManual(
      fakeDb({ PROD: { paiId: null } }),
      { integracaoId: CONTA, produtoIds: ['PROD'], reenviarComErro: true },
      deps as never,
    );
    expect(deps.api.getItem).toHaveBeenCalledWith('MLB111');
    expect(res.listings[0]).toMatchObject({ outcome: 'enviado' });
    expect(res.listings[0]!.rearme).toMatchObject({ executado: true, enviavel: true });
  });

  it('re-armed but ML still refuses → the MORE informative status skip', async () => {
    const deps = baseDeps({
      fetchFamilies: vi.fn().mockResolvedValue([latched()]),
      api: {
        getMe: vi.fn().mockResolvedValue({ tags: [] }),
        getItem: vi.fn().mockResolvedValue({ id: 'MLB111', status: 'closed', sub_status: [] }),
      },
    });
    const res = await enviarEstoqueManual(
      fakeDb({ PROD: { paiId: null } }),
      { integracaoId: CONTA, produtoIds: ['PROD'], reenviarComErro: true },
      deps as never,
    );
    expect(res.listings[0]).toMatchObject({ outcome: 'pulado', motivo: 'status-nao-enviavel' });
  });
});

/**
 * The re-arm on a User-Products FAMILY (#1142). Every fixture above stays on the
 * single-listing path — `collectionGroup` answers empty — so none of this branch
 * was reachable before.
 */
describe('enviarEstoqueManual — re-arming a User-Products família', () => {
  const PML_REF = 'documents/produtos/PROD/produtoMercadoLivre/link1';

  const filho = (produtoId: string, itemId: string, status: string | null, qtd: number) => ({
    produtoId,
    ehKit: false,
    ehKitVirtual: false,
    publicado: true,
    componentesKit: null,
    timestampMs: null,
    estoque: { quantidade: qtd, quantidadeReservada: 0 },
    componentEstoques: [],
    varLinks: [
      {
        itemId,
        varLinkDocId: `v-${produtoId}`,
        produtoMercadoLivreOuterRef: PML_REF,
        status,
        sub_status: [],
      },
    ],
  });

  /** A family latched at `estado 'E'`, with two members on two children. */
  const familiaLatched = (varStatus: Array<string | null>) =>
    familyRow({
      links: [
        {
          id: 'FAM-9',
          linkDocId: 'link1',
          estado: 'E',
          status: 'active',
          isUserProductModel: true,
        },
      ],
      children: [
        filho('childA', 'MLB-A', varStatus[0] ?? null, 4),
        filho('childB', 'MLB-B', varStatus[1] ?? null, 5),
      ],
    } as never);

  const membrosNoDb = [
    {
      docId: 'v-childA',
      child: 'childA',
      data: { itemId: 'MLB-A', produtoMercadoLivreOuterRef: PML_REF },
    },
    {
      docId: 'v-childB',
      child: 'childB',
      data: { itemId: 'MLB-B', produtoMercadoLivreOuterRef: PML_REF },
    },
  ];

  const multiget = (entries: Array<{ id: string; status: string }>) =>
    vi.fn().mockResolvedValue(entries.map((e) => ({ code: 200, body: { ...e, sub_status: [] } })));

  it('⚠️ patches the MEMBER rows, not just the parent — or it skips what ML just healed', async () => {
    // The failure this pins: `buildSendTasks`' UP branch gates per member on
    // `child.varLinks[].status`, NOT on the parent. A member stored `paused`
    // (no `out_of_stock`) that ML now reports `active` cleared the family latch
    // and was then skipped `status-nao-enviavel` in the very run the operator
    // asked for.
    const deps = baseDeps({
      fetchFamilies: vi.fn().mockResolvedValue([familiaLatched(['paused', 'active'])]),
      api: {
        getMe: vi.fn().mockResolvedValue({ tags: [] }),
        getItem: vi.fn(),
        getItemsByIds: multiget([
          { id: 'MLB-A', status: 'active' },
          { id: 'MLB-B', status: 'active' },
        ]),
      },
    });

    const res = await enviarEstoqueManual(
      fakeDb({ PROD: { paiId: null, nome: 'Camiseta' } }, membrosNoDb),
      { integracaoId: CONTA, produtoIds: ['PROD'], reenviarComErro: true },
      deps as never,
    );

    // NEVER the item endpoint with a family id — that 404 records `closed`.
    expect(deps.api.getItem).not.toHaveBeenCalled();
    // Both members send; the previously-`paused` one is no longer skipped.
    expect(res.listings.filter((l) => l.outcome === 'enviado')).toHaveLength(2);
    expect(res.listings.some((l) => l.motivo === 'status-nao-enviavel')).toBe(false);
  });

  it('⚠️ leaves an UNREAD member on its stored status, never on the report null', async () => {
    // `membroPodeEnviar` reads a null status as "never observed, send
    // optimistically" (#780), so writing the report's `null` over a stored
    // `closed` would turn a member ML declined to answer for into one this run
    // sends to.
    const deps = baseDeps({
      fetchFamilies: vi.fn().mockResolvedValue([familiaLatched(['closed', 'active'])]),
      api: {
        getMe: vi.fn().mockResolvedValue({ tags: [] }),
        getItem: vi.fn(),
        // ML answers for B only; A comes back 500 inside the 200 envelope.
        getItemsByIds: vi.fn().mockResolvedValue([
          { code: 500, body: null },
          { code: 200, body: { id: 'MLB-B', status: 'active', sub_status: [] } },
        ]),
      },
    });

    const res = await enviarEstoqueManual(
      fakeDb({ PROD: { paiId: null, nome: 'Camiseta' } }, membrosNoDb),
      { integracaoId: CONTA, produtoIds: ['PROD'], reenviarComErro: true },
      deps as never,
    );

    // A keeps `closed` and is skipped; B was read and sends.
    expect(res.listings.some((l) => l.motivo === 'status-nao-enviavel')).toBe(true);
    expect(res.listings.filter((l) => l.outcome === 'enviado')).toHaveLength(1);
  });

  it('⚠️ charges the re-arm budget by ML CALLS, not by listings', async () => {
    // `MERCADO_LIVRE_STOCK_MANUAL_REARM_MAX_GETS` is documented as a cap on
    // calls. A família is one multiget per 20 members plus a `/moderations` read
    // per moderated member — a flat `-= 1` let one unit buy all of that.
    //
    // ⚠️ The two members are MODERATED on purpose, and the budget is 2 rather
    // than 1. A clean 2-member família costs exactly one multiget, so charging
    // per call and charging a flat unit both spend 1 and the test cannot tell
    // them apart — it passed against the flat version. Moderated, the real cost
    // is 1 multiget + 2 `/moderations` reads = 3, which overruns a budget of 2
    // while a flat unit leaves 1 and re-arms the second listing.
    process.env.MERCADO_LIVRE_STOCK_MANUAL_REARM_MAX_GETS = '2';
    try {
      const deps = baseDeps({
        fetchFamilies: vi.fn().mockResolvedValue([
          familiaLatched(['active', 'active']),
          familyRow({
            anchorId: 'PROD2',
            links: [{ id: 'MLB999', linkDocId: 'link9', estado: 'E', status: 'active' }],
          }),
        ]),
        api: {
          getMe: vi.fn().mockResolvedValue({ tags: [] }),
          getItem: vi.fn().mockResolvedValue({ id: 'MLB999', status: 'active', sub_status: [] }),
          getLastModeration: vi.fn().mockResolvedValue([]),
          getItemsByIds: vi.fn().mockResolvedValue([
            {
              code: 200,
              body: { id: 'MLB-A', status: 'active', sub_status: ['poor_quality_thumbnail'] },
            },
            {
              code: 200,
              body: { id: 'MLB-B', status: 'active', sub_status: ['poor_quality_thumbnail'] },
            },
          ]),
        },
      });

      const res = await enviarEstoqueManual(
        fakeDb({ PROD: { paiId: null, nome: 'Camiseta' }, PROD2: { paiId: null } }, membrosNoDb),
        { integracaoId: CONTA, produtoIds: ['PROD', 'PROD2'], reenviarComErro: true },
        deps as never,
      );

      // Both moderation reads actually happened — the cost being charged is real.
      expect(deps.api.getLastModeration).toHaveBeenCalledTimes(2);
      // The família overran the budget, so the SECOND listing never reaches ML.
      expect(deps.api.getItem).not.toHaveBeenCalled();
      expect(res.listings.some((l) => l.rearme?.executado === false)).toBe(true);
    } finally {
      delete process.env.MERCADO_LIVRE_STOCK_MANUAL_REARM_MAX_GETS;
    }
  });
});

/* -------------------------------- reporting --------------------------------- */

describe('enviarEstoqueManual — nothing is dropped silently', () => {
  it('a produto with no family row is reported, not omitted', async () => {
    const deps = baseDeps({ fetchFamilies: vi.fn().mockResolvedValue([]) });
    const res = await enviarEstoqueManual(
      fakeDb({ PROD: { paiId: null, nome: 'Camiseta' } }),
      { integracaoId: CONTA, produtoIds: ['PROD'] },
      deps as never,
    );
    expect(res.produtosSemEnvio).toEqual([
      expect.objectContaining({ produtoId: 'PROD', motivo: 'familia-nao-encontrada' }),
    ]);
  });

  it('an unpublished produto with a live listing produces a SKIP ROW (#804)', async () => {
    // The by-ids fetcher drops the sweep's `publicado` pre-filter precisely so
    // this rung fires instead of the produto vanishing from the result.
    const row = familyRow();
    row.anchor.publicado = false;
    const deps = baseDeps({ fetchFamilies: vi.fn().mockResolvedValue([row]) });
    const res = await enviarEstoqueManual(
      fakeDb({ PROD: { paiId: null } }),
      { integracaoId: CONTA, produtoIds: ['PROD'] },
      deps as never,
    );
    expect(res.listings[0]).toMatchObject({ outcome: 'pulado', motivo: 'nao-publicado' });
  });
});
