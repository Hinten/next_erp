import type { Firestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreError, MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

import {
  MANUAL_PUSH_MAX_ATTEMPTS,
  ManualPushGuardError,
  enviarEstoqueManual,
  resolverAnchors,
  toPushOutcome,
} from './estoqueManual';
import { STOCK_SEND_MAX_ATTEMPTS, type StockFamilyRow } from './estoquePlan';
import type { StockSendResult } from './estoqueSend';

vi.mock('./itemsStatusSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./itemsStatusSync')>();
  return { ...actual, applyItemStatusToLink: vi.fn().mockResolvedValue(true) };
});

const CONTA = 'conta-1';
const CONTA_DOC = { depositoOuterRef: 'documents/depositos/DEP1', nome: 'Loja ML' };

/* --------------------------------- fixtures -------------------------------- */

/** Minimal fake Firestore: `resolverAnchors` only needs docRef + getAll. */
function fakeDb(docs: Record<string, Record<string, unknown> | null>): Firestore {
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({ id, path: `${name}/${id}`, __id: id }),
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
    api: {
      getItem: vi.fn(),
      getMe: vi.fn().mockResolvedValue({ id: 1, tags: [] }),
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

  it('refuses a multiorigin conta — ML SILENTLY IGNORES stock PUTs there', async () => {
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
