import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryFirestore } from '@delfrance/data/testing';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  MercadoLivreReauthRequiredError,
  MercadoLivreNetworkError,
  MercadoLivreValidationError,
  type MercadoLivreApi,
  type MlMissedFeed,
  type MlMissedFeeds,
} from '@delfrance/integrations-mercado-livre';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  integracaoCollection,
  missedFeedsMercadoLivreCollection,
} from '@delfrance/data/admin/collections';
import { MlTasksDisabledError, type MlTaskScheduler } from './mlTasks';

const h = vi.hoisted(() => ({ loadCtx: vi.fn(), createApi: vi.fn() }));
vi.mock('../core/mercadoLivre', async (importActual) => ({
  ...(await importActual<typeof import('../core/mercadoLivre')>()),
  loadMercadoLivreContext: h.loadCtx,
}));
vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/integrations-mercado-livre')>()),
  createMercadoLivreApi: h.createApi,
}));
import {
  APP_ID_INVALIDO_ERROR,
  MAX_PAGES_PER_TICK,
  MISSED_FEEDS_FLAG_ENV,
  MISSED_FEEDS_RETENTION_HOURS,
  PAGE_LIMIT,
  MAX_SWEEP_DURATION_MS,
  runMissedFeedsSweep,
  recordMissedFeedsHealth,
} from './missedFeedsSweep';
import { missedFeedsSites } from './missedFeedsAccess';
import {
  KNOWN_TOPICS,
  handleNotificationTask,
  reprocessNotifications,
  shouldEnqueueTopic,
} from './notificacao';

type DocData = Record<string, unknown>;
type OpKind = 'get' | 'set';

interface FakeSnap {
  exists: boolean;
  id: string;
  data: () => DocData | undefined;
}

interface FakeDocRef {
  id: string;
  get: () => Promise<FakeSnap>;
  set: (data: DocData, opts?: { merge?: boolean }) => void;
}

interface FakeQueryDoc {
  id: string;
  data: () => DocData;
  exists: true;
}

interface FakeQuery {
  where: (field: string, op: string, value: unknown) => FakeQuery;
  orderBy: (field: string) => FakeQuery;
  limit: (n: number) => FakeQuery;
  get: () => Promise<{ docs: FakeQueryDoc[]; empty: boolean }>;
  /** Test-only: the (field, op, value) triples this query was built with. */
  readonly clauses: Array<[string, string, unknown]>;
}

interface FakeCollection {
  doc: (id?: string) => FakeDocRef;
  where: (field: string, op: string, value: unknown) => FakeQuery;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly opLog: Array<{ op: OpKind; path: string }> = [];
  /** Every query built this tick — lets a test assert the enumeration shape. */
  readonly queries: FakeQuery[] = [];
  private autoN = 0;
  async runTransaction<T>(
    fn: (tx: {
      get: (ref: FakeDocRef) => Promise<FakeSnap>;
      set: (ref: FakeDocRef, data: DocData) => void;
    }) => Promise<T>,
  ): Promise<T> {
    return fn({
      get: (ref) => ref.get(),
      set: (ref, data) => {
        ref.set(data);
      },
    });
  }

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }

  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }

  private makeQuery(entries: Array<{ id: string; data: DocData }>): FakeQuery {
    const clauses: Array<[string, string, unknown]> = [];
    let lim: number | null = null;
    const self = this;
    const q: FakeQuery = {
      clauses,
      where(field, op, value) {
        clauses.push([field, op, value]);
        return q;
      },
      orderBy() {
        return q;
      },
      limit(n) {
        lim = n;
        return q;
      },
      async get() {
        self.opLog.push({ op: 'get', path: 'query' });
        let rows = entries.filter((e) =>
          clauses.every(([f, op, v]) =>
            op === '<' ? Number(e.data[f]) < Number(v) : e.data[f] === v,
          ),
        );
        if (lim != null) rows = rows.slice(0, lim);
        return {
          docs: rows.map((e) => ({ id: e.id, data: () => e.data, exists: true as const })),
          empty: rows.length === 0,
        };
      },
    };
    this.queries.push(q);
    return q;
  }

  private makeDocRef(path: string, id: string): FakeDocRef {
    const self = this;
    const col = this.col(path);
    return {
      id,
      get: async () => {
        self.opLog.push({ op: 'get', path: `${path}/${id}` });
        return { exists: col.has(id), id, data: () => col.get(id) };
      },
      set: (data: DocData, opts?: { merge?: boolean }) => {
        self.opLog.push({ op: 'set', path: `${path}/${id}` });
        if (opts?.merge) col.set(id, { ...(col.get(id) ?? {}), ...data });
        else col.set(id, { ...data });
      },
    };
  }

  collection(path: string): FakeCollection {
    const self = this;
    const col = this.col(path);
    return {
      doc(id?: string) {
        return self.makeDocRef(path, id ?? `auto-${++self.autoN}`);
      },
      where(field, op, value) {
        const entries = [...col.entries()].map(([id, d]) => ({ id, data: d }));
        return self.makeQuery(entries).where(field, op, value);
      },
    };
  }
}

const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const HEALTH_PATH = missedFeedsMercadoLivreCollection.resolvePath({});

const NOW_MS = Date.parse('2026-08-12T08:00:00.000Z');
const NOW_US = NOW_MS * 1000;
const APP_ID = '3486171129139063';
const SELLER = 465432224;

function seedConta(db: FakeDb, id: string, userId: number | null): void {
  db.seed(INTEGRACAO_PATH, id, {
    tipo: INTEGRACAO_TIPO.mercadoLivre,
    ativo: true,
    user_id: userId,
    nome: `Conta ${id}`,
  });
}

function makeScheduler() {
  // Typed off the seam so `enqueue.mock.calls[0]` is the real `(payload, opts?)`
  // tuple — that is what lets a test assert the payload AND that the second
  // argument was never passed (no `scheduleDelaySeconds`).
  const enqueue = vi.fn<MlTaskScheduler['enqueue']>(async () => {});
  const scheduler: MlTaskScheduler = { enqueue };
  return { scheduler, enqueue };
}

/** One `missed_feeds` entry in ML's real wire shape (ISO dates, string user_id). */
function feed(over: Partial<MlMissedFeed> = {}): MlMissedFeed {
  return {
    _id: 'feed-1',
    resource: '/payments/1234567890',
    topic: 'payments',
    user_id: String(SELLER),
    application_id: Number(APP_ID),
    attempts: 8,
    sent: '2026-08-11T07:00:00.000Z',
    received: '2026-08-11T07:00:00.100Z',
    request: {
      url: 'https://ml.example.com/api/webhooks/mercado-livre?k=super-secret-path',
      headers: { accept: 'application/json' },
      data: '{"resource":"/payments/1234567890"}',
    },
    response: { http_code: 500, req_time: 260, body: 'boom' },
    ...over,
  } as MlMissedFeed;
}

function page(messages: MlMissedFeed[]): MlMissedFeeds {
  return { messages } as MlMissedFeeds;
}

type FeedParams = Parameters<MercadoLivreApi['getMissedFeeds']>[0];
type ResponsePlan = Record<string, MlMissedFeeds[] | Error>;
function wireApi(pagesByConta: Record<string, MlMissedFeeds[]>, streams: ResponsePlan = {}) {
  const tokens = new Map<string, ReturnType<typeof vi.fn<() => Promise<string>>>>();
  const configCandidates = new Map<() => Promise<string>, string>();
  const calls: Record<string, number> = {};
  const getMissedFeeds = vi.fn(async (id: string, params: FeedParams) => {
    const key = id + '/' + (params.topic ?? 'all') + '/' + (params.siteId ?? '-');
    const plan = streams[key] ?? (params.topic == null ? pagesByConta[id] : undefined);
    if (plan instanceof Error) throw plan;
    const n = calls[key] ?? 0;
    calls[key] = n + 1;
    return plan?.[n] ?? page([]);
  });
  h.loadCtx.mockImplementation(async (_db: Firestore, id: string) => {
    const token = vi.fn<() => Promise<string>>(async () => 'tok-' + id);
    tokens.set(id, token);
    configCandidates.set(token, id);
    return {
      integracaoId: id,
      conta: {},
      store: {},
      resolveChannelContext: async () => ({
        accessToken: 'STALE-SNAPSHOT',
        getAccessToken: token,
        account: {},
      }),
    };
  });
  h.createApi.mockImplementation(
    ({ getAccessToken }: { getAccessToken: () => Promise<string> }) => ({
      getMissedFeeds: async (params: FeedParams) => {
        await getAccessToken();
        return getMissedFeeds(configCandidates.get(getAccessToken)!, params);
      },
    }),
  );
  return { getMissedFeeds, tokens };
}
function run(db: FakeDb, scheduler: MlTaskScheduler) {
  return runMissedFeedsSweep(db as unknown as Firestore, { scheduler, nowMs: NOW_MS });
}
beforeEach(() => {
  vi.stubEnv(MISSED_FEEDS_FLAG_ENV, '1');
  vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', APP_ID);
  vi.stubEnv('MERCADO_LIVRE_MISSED_FEEDS_SITE_IDS', '');
  h.loadCtx.mockReset();
  h.createApi.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS + 12 * 3600_000);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('automatic application-feed access (#1292)', () => {
  it.each(['', '0', 'true', 'yes'])('flag %o reads and writes nothing', async (flag) => {
    vi.stubEnv(MISSED_FEEDS_FLAG_ENV, flag);
    const db = new FakeDb();
    const { scheduler, enqueue } = makeScheduler();
    expect(await run(db, scheduler)).toMatchObject({ enabled: false, complete: false });
    expect(db.opLog).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(h.loadCtx).not.toHaveBeenCalled();
  });
  it.each(['', '0', 'abc', '12x'])('invalid app ID %o fails once at app level', async (appId) => {
    vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', appId);
    const db = new FakeDb();
    const { scheduler } = makeScheduler();
    const result = await run(db, scheduler);
    expect(result).toMatchObject({
      configured: false,
      complete: false,
      errors: [APP_ID_INVALIDO_ERROR],
    });
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(db.docs(HEALTH_PATH).get('app-unconfigured')?.complete).toBe(false);
  });
  it('skips disconnected candidates and seller rejections, selects stably, and stops', async () => {
    const db = new FakeDb();
    for (const id of ['D-unused', 'C-owner', 'B-seller', 'A-disconnected'])
      seedConta(db, id, SELLER);
    db.seed(INTEGRACAO_PATH, '0-off', { tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: false });
    db.seed(INTEGRACAO_PATH, '0-other', { tipo: 'other', ativo: true });
    const { scheduler } = makeScheduler();
    const { getMissedFeeds } = wireApi(
      {},
      {
        'B-seller/items/MLB': new MercadoLivreReauthRequiredError(
          'refresh_failed',
          'owner only',
          401,
          { message: 'owner only' },
        ),
      },
    );
    const connected = h.loadCtx.getMockImplementation()!;
    h.loadCtx.mockImplementation(async (db: Firestore, id: string) => {
      if (id === 'A-disconnected')
        throw new MercadoLivreReauthRequiredError('no_token', 'disconnected');
      return connected(db, id);
    });
    const result = await run(db, scheduler);
    expect(h.loadCtx.mock.calls.map((call) => call[1])).toEqual([
      'A-disconnected',
      'B-seller',
      'C-owner',
    ]);
    expect(result).toMatchObject({
      selectedIntegracaoId: 'C-owner',
      examined: 3,
      rejected: 2,
      complete: true,
    });
    expect(getMissedFeeds.mock.calls.map((call) => call[0])).toEqual([
      'B-seller',
      'C-owner',
      'C-owner',
    ]);
    expect(db.queries[0]!.clauses.map(([field]) => field)).toEqual(['tipo', 'ativo']);
    // Rejections only write app health; no credential or integration is mutated.
    expect(db.opLog.filter((op) => op.op === 'set').map((op) => op.path)).toEqual([
      HEALTH_PATH + '/app-' + APP_ID,
    ]);
  });
  it('accepts an empty first page, reuses it, and ignores additional accounts', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    seedConta(db, 'INT-B', SELLER + 1);
    const { scheduler } = makeScheduler();
    const { getMissedFeeds, tokens } = wireApi({});
    const result = await run(db, scheduler);
    expect(result.complete).toBe(true);
    expect(result.examined).toBe(1);
    expect(getMissedFeeds).toHaveBeenCalledTimes(2);
    expect(getMissedFeeds).toHaveBeenNthCalledWith(1, 'INT-A', {
      appId: APP_ID,
      topic: 'items',
      siteId: 'MLB',
      limit: PAGE_LIMIT,
      offset: 0,
    });
    expect(tokens.get('INT-A')).toHaveBeenCalledTimes(2);
    expect(h.createApi).toHaveBeenCalledWith(
      expect.objectContaining({ getAccessToken: tokens.get('INT-A') }),
    );
  });
  it('uses the refreshable callback again after an enqueue rather than the token snapshot', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    const entry = feed({ topic: 'items', resource: '/items/MLB1' });
    const { tokens } = wireApi({}, { 'INT-A/items/MLB': [page([entry]), page([])] });
    enqueue.mockImplementation(async () => {
      tokens.get('INT-A')!.mockResolvedValue('refreshed-token');
    });
    expect((await run(db, scheduler)).complete).toBe(true);
    const token = tokens.get('INT-A')!;
    expect(token).toHaveBeenCalledTimes(3);
    expect(await token.mock.results.at(-1)?.value).toBe('refreshed-token');
  });
  it('reports no access instead of a healthy empty feed', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler } = makeScheduler();
    wireApi(
      {},
      {
        'INT-A/items/MLB': new MercadoLivreHttpError('forbidden', 403, null),
      },
    );
    const result = await run(db, scheduler);
    expect(result.complete).toBe(false);
    expect(result.errors[0]).toContain('NO_FEED_ACCESS');
    expect(db.docs(HEALTH_PATH).get('app-' + APP_ID)?.lastSuccessAtUs).toBeNull();
  });
  it.each([
    new MercadoLivreHttpError('private-body', 429, { secret: 'do-not-log' }),
    new MercadoLivreHttpError('private-body', 500, null),
    new MercadoLivreNetworkError('private-body'),
    new MercadoLivreValidationError('private-body', []),
  ])('does not mistake provider failure for an absent authenticated account: %s', async (error) => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    seedConta(db, 'INT-B', SELLER + 1);
    const { scheduler } = makeScheduler();
    wireApi({}, { 'INT-A/items/MLB': error });
    const result = await run(db, scheduler);
    expect(result.complete).toBe(false);
    expect(result.errors.join()).not.toContain('NO_FEED_ACCESS');
    expect(JSON.stringify(result)).not.toMatch(/private-body|do-not-log/);
    expect(h.loadCtx).toHaveBeenCalledTimes(1);
    expect(result.examined).toBe(1);
  });
  it('propagates unexpected exceptions', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler } = makeScheduler();
    wireApi({}, { 'INT-A/items/MLB': new TypeError('bug') });
    await expect(run(db, scheduler)).rejects.toThrow('bug');
  });
});

describe('runMissedFeedsSweep — topic filtering', () => {
  it('enqueues EVERY enqueueable topic (no private topic list)', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    const enqueueable = [...KNOWN_TOPICS].filter((t) => shouldEnqueueTopic(t));
    wireApi({
      'INT-A': [
        page(enqueueable.map((t, i) => feed({ _id: `f-${i}`, topic: t, resource: `/x/${i}` }))),
      ],
    });

    const res = await run(db, scheduler);

    // Anti-drift: if the sweep ever re-declares its own topic set instead of
    // importing the shared one, nothing else in the repo reds.
    expect(enqueue).toHaveBeenCalledTimes(enqueueable.length);
    expect(res.streams[1]!.skippedTopic).toBe(0);
  });

  it('an IGNORED topic is skipped here too — the sweep is the second producer', async () => {
    // Without this the 05:00 replay would re-enqueue every ignored delivery
    // ML filed as missed, every morning, undoing the receiver's gate (#813).
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({
      'INT-A': [
        page([
          feed({ _id: 'f-0', topic: 'public_offers', resource: '/seller-promotions/offers/1' }),
          feed({ _id: 'f-1', topic: 'orders_v2', resource: '/orders/1' }),
        ]),
      ],
    });

    const res = await run(db, scheduler);

    expect(enqueue).toHaveBeenCalledTimes(1);
    // Counted apart from `skippedTopic`: an unknown topic means a new ML topic
    // needs classifying (act on it), an ignored one means the list worked
    // (noise). Summed, the number that should prompt action is buried.
    expect(res.streams[1]!.skippedIgnorado).toBe(1);
    expect(res.streams[1]!.skippedTopic).toBe(0);
  });

  it('a topic outside KNOWN_TOPICS is SKIPPED, COUNTED and never enqueued', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({
      'INT-A': [
        page([
          feed({ _id: 'a', topic: 'payments' }),
          feed({ _id: 'b', topic: 'topico_novo' }),
          feed({ _id: 'c', topic: 'orders_v2' }),
        ]),
      ],
    });

    const res = await run(db, scheduler);

    // Enqueuing it would park a `notificacoesMercadoLivre` doc per delivery —
    // one new terminal row every morning, forever, for a topic nobody handles.
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(res.streams[1]).toMatchObject({ found: 3, novos: 3, enqueued: 2, skippedTopic: 1 });
    expect(res.topicosPulados).toEqual({ topico_novo: 1 });
  });

  it('items_prices is enqueued, not "optimised" away', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({ 'INT-A': [page([feed({ topic: 'items_prices', resource: '/items/MLB1' })])] });

    await run(db, scheduler);

    // It is deliberately a KNOWN_TOPICS member (#803) so a delivery acks `done`
    // and persists nothing. Filtering it here would route it to `unknown-topic`
    // — a parked doc per replay.
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('an entry with a null topic is counted under "(sem topic)"', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({ 'INT-A': [page([feed({ _id: 'a', topic: null })])] });

    const res = await run(db, scheduler);

    expect(enqueue).not.toHaveBeenCalled();
    expect(res.topicosPulados).toEqual({ '(sem topic)': 1 });
  });
});

describe('runMissedFeedsSweep — entry normalization', () => {
  async function enqueuedPayload(entry: MlMissedFeed): Promise<Record<string, unknown>> {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({ 'INT-A': [page([entry])] });
    await run(db, scheduler);
    return enqueue.mock.calls[0]![0] as unknown as Record<string, unknown>;
  }

  it('⚠️ forwards the SUBTOPIC `actions` — a replay must be the SAME event (#1322)', async () => {
    // `toWire` built the payload from eight keys and `actions` was not among
    // them, so every recovered entry arrived with `actions: null`. Two topics
    // dispatch on that field, so the omission made a replay a DIFFERENT event
    // from the delivery it was recovering.
    //
    // `messages` absorbed it harmlessly (absent ⇒ treated as `created` ⇒
    // import, so a replayed read receipt merely re-imported), which is why it
    // went unnoticed for so long. `post_purchase` degrades the other way:
    // absent ⇒ past the unknown-subtopic guard ⇒ an unparseable resource then
    // DROPS in the task phase instead of parking — the silent loss #813 exists
    // to prevent, through the one mechanism whose whole job is recovery.
    const p = await enqueuedPayload(
      feed({
        topic: 'post_purchase',
        resource: '/post-purchase/v1/claims/5567065796',
        actions: ['claims_actions'],
      }),
    );
    expect(p.actions).toEqual(['claims_actions']);
  });

  it('an entry ML sent no `actions` for stays null — the field is forwarded, not invented', async () => {
    const p = await enqueuedPayload(feed());
    expect(p.actions).toBeNull();
  });

  it('ISO-8601 sent/received coerce to epoch millis', async () => {
    const p = await enqueuedPayload(feed());
    expect(p.sent).toBe(Date.parse('2026-08-11T07:00:00.000Z'));
    expect(p.received).toBe(Date.parse('2026-08-11T07:00:00.100Z'));
  });

  it('a STRING user_id coerces to a number (#810, one path over)', async () => {
    const p = await enqueuedPayload(feed({ user_id: '465432224' }));
    expect(p.user_id).toBe(465432224);
  });

  it('_id becomes the payload id (the load-bearing _id → id alias)', async () => {
    const p = await enqueuedPayload(feed({ _id: 'ml-notification-id' }));
    expect(p.id).toBe('ml-notification-id');
    expect(p._id).toBeUndefined();
  });

  it('an _id shaped like a PATH is refused as a doc id and rides as null', async () => {
    const p = await enqueuedPayload(feed({ _id: 'a/b/c' }));
    // `docIdOf` feeds this straight into `docRef(...).create()`, so an
    // unvalidated one is a PATH — a silent black hole below the sweep's query.
    expect(p.id).toBeNull();
  });

  it('an entry with no _id still enqueues (id: null retains deterministic downstream fallback)', async () => {
    const p = await enqueuedPayload(feed({ _id: null }));
    expect(p.id).toBeNull();
    expect(p.resource).toBe('/payments/1234567890');
  });

  it('stamps origem: missed_feeds so a recovered notification is greppable', async () => {
    const p = await enqueuedPayload(feed());
    expect(p.origem).toBe('missed_feeds');
  });

  it('NEVER carries request/response onto the payload', async () => {
    const p = await enqueuedPayload(feed());
    // `request.url` can carry a secret path segment (#811's named follow-up),
    // and `sanitizeRemainder` would otherwise JSON-stringify both blobs onto
    // every payload AND every persisted failure doc.
    expect(p.request).toBeUndefined();
    expect(p.response).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain('super-secret-path');
  });

  it('an entry with no resource is DROPPED, counted, never enqueued', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({ 'INT-A': [page([feed({ resource: null })])] });

    const res = await run(db, scheduler);

    expect(enqueue).not.toHaveBeenCalled();
    expect(res.streams[1]).toMatchObject({ found: 1, enqueued: 0, skippedInvalid: 1 });
  });

  it('an entry naming a DIFFERENT seller is enqueued verbatim, not filtered', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({ 'INT-A': [page([feed({ _id: 'x', user_id: 999 })])] });

    const res = await run(db, scheduler);

    // If ML's response is app-wide, filtering by the calling conta would
    // discard other sellers' recoverable entries. `resolveIntegracaoByUserId`
    // downstream is the authority; an unconnected seller lands in the deferred
    // lane (#808) rather than being lost.
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((enqueue.mock.calls[0]![0] as unknown as Record<string, unknown>).user_id).toBe(999);
    expect(res.selectedIntegracaoId).toBe('INT-A');
  });

  it('enqueues with NO options argument (no scheduleDelaySeconds)', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({ 'INT-A': [page([feed({ topic: 'orders_v2', resource: '/orders/1' })])] });

    await run(db, scheduler);

    // The receiver delays order-family topics 10s because ML is eventually
    // consistent on FRESH events. A missed feed is ≥1h old by construction, so
    // a copy-pasted delay would only slow the drain.
    expect(enqueue.mock.calls[0]).toHaveLength(1);
  });
});

describe('stream coverage and health', () => {
  it('deduplicates within and across item sites, pages and the unfiltered feed', async () => {
    vi.stubEnv('MERCADO_LIVRE_MISSED_FEEDS_SITE_IDS', 'MLB,MLA');
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    const entry = feed({ topic: 'items', resource: '/items/MLB1' });
    wireApi(
      { 'INT-A': [page([entry])] },
      {
        'INT-A/items/MLB': [page([entry, entry]), page([entry]), page([])],
        'INT-A/items/MLA': [page([entry]), page([])],
      },
    );
    const result = await run(db, scheduler);
    expect(result.complete).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(result.streams.map((stream) => stream.enqueued)).toEqual([1, 0, 0]);
  });
  it('keeps no-ID entries with distinct sent dates distinct', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({
      'INT-A': [
        page([
          feed({ _id: null }),
          feed({ _id: null }),
          feed({ _id: null, sent: '2026-08-11T08:00:00Z' }),
        ]),
      ],
    });
    await run(db, scheduler);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
  it('advances offsets by actual page lengths and waits for an empty page', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler } = makeScheduler();
    const { getMissedFeeds } = wireApi({
      'INT-A': [
        page([feed({ _id: 'a' }), feed({ _id: 'b' })]),
        page([feed({ _id: 'c' })]),
        page([]),
      ],
    });
    const result = await run(db, scheduler);
    expect(
      getMissedFeeds.mock.calls
        .filter(([, params]) => params.topic == null)
        .map(([, params]) => params.offset),
    ).toEqual([0, 2, 3]);
    expect(result.streams[1]).toMatchObject({ pages: 3, found: 3, complete: true });
  });
  it('uses topic streams only for an explicit missing-site 400', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler } = makeScheduler();
    const { getMissedFeeds } = wireApi(
      {},
      {
        'INT-A/all/-': new MercadoLivreHttpError('site_id required', 400, {
          message: 'site_id is required',
        }),
      },
    );
    const result = await run(db, scheduler);
    expect(result).toMatchObject({ complete: true, queryMode: 'topics' });
    expect(result.streams.map((stream) => stream.topic).sort()).toEqual(
      [...KNOWN_TOPICS].filter(shouldEnqueueTopic).sort(),
    );
    expect(getMissedFeeds.mock.calls.filter(([, params]) => params.topic === 'items')).toHaveLength(
      1,
    );
  });
  it('does not hide unrelated unfiltered 400s behind a topic fallback', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler } = makeScheduler();
    wireApi(
      {},
      { 'INT-A/all/-': new MercadoLivreHttpError('bad app id', 400, { message: 'bad app id' }) },
    );
    expect(await run(db, scheduler)).toMatchObject({ complete: false, errors: ['ML_HTTP_400'] });
  });
  it('continues other sites after an expected stream failure', async () => {
    vi.stubEnv('MERCADO_LIVRE_MISSED_FEEDS_SITE_IDS', 'MLB,MLA,MLM');
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler } = makeScheduler();
    wireApi({}, { 'INT-A/items/MLA': new MercadoLivreHttpError('boom', 500, null) });
    const result = await run(db, scheduler);
    expect(result.complete).toBe(false);
    expect(result.streams.map((stream) => [stream.siteId, stream.complete])).toEqual([
      ['MLB', true],
      ['MLA', false],
      ['MLM', true],
      [null, true],
    ]);
  });
  it('page exhaustion is incomplete and cannot advance last success', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler } = makeScheduler();
    db.seed(HEALTH_PATH, 'app-' + APP_ID, {
      lastSweepAtUs: NOW_US - 2000,
      lastSuccessAtUs: NOW_US - 2000,
    });
    wireApi({
      'INT-A': Array.from({ length: MAX_PAGES_PER_TICK }, (_, i) =>
        page([feed({ _id: 'f-' + i })]),
      ),
    });
    const result = await run(db, scheduler);
    expect(result).toMatchObject({ complete: false });
    expect(result.streams[1]).toMatchObject({ truncated: true, error: 'PAGE_BUDGET_EXHAUSTED' });
    expect(db.docs(HEALTH_PATH).get('app-' + APP_ID)).toMatchObject({
      lastSweepAtUs: NOW_US,
      lastSuccessAtUs: NOW_US - 2000,
      lastTruncated: true,
      complete: false,
    });
  });
  it('time exhaustion remains visible', async () => {
    const db = new FakeDb();
    const { scheduler } = makeScheduler();
    const clock = vi.fn().mockReturnValueOnce(0).mockReturnValue(MAX_SWEEP_DURATION_MS);
    const result = await runMissedFeedsSweep(db as unknown as Firestore, {
      scheduler,
      nowMs: NOW_MS,
      monotonicNow: clock,
    });
    expect(result).toMatchObject({ complete: false, errors: ['SWEEP_TIME_BUDGET_EXHAUSTED'] });
  });
  it('enqueue failure remains retryable in another stream and does not lose a dedup key', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    const entry = feed({ topic: 'items', resource: '/items/MLB1' });
    wireApi({ 'INT-A': [page([entry])] }, { 'INT-A/items/MLB': [page([entry])] });
    enqueue.mockRejectedValueOnce(new MlTasksDisabledError());
    const result = await run(db, scheduler);
    expect(result.complete).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(result.streams[1]?.enqueued).toBe(1);
  });
  it('older or equal attempts cannot replace newer health', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler } = makeScheduler();
    wireApi({});
    const result = await run(db, scheduler);
    const health = structuredClone(db.docs(HEALTH_PATH).get('app-' + APP_ID));
    result.complete = false;
    result.errors = ['older-failure'];
    expect(await recordMissedFeedsHealth(db as unknown as Firestore, result, NOW_US - 1)).toBe(
      false,
    );
    expect(await recordMissedFeedsHealth(db as unknown as Firestore, result, NOW_US)).toBe(false);
    expect(db.docs(HEALTH_PATH).get('app-' + APP_ID)).toEqual(health);
  });
  it('rechecks the attempt watermark after an OCC retry', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler } = makeScheduler();
    wireApi({});
    const result = await run(db, scheduler);
    const memory = new MemoryFirestore();
    let injected = false;
    memory.occ.beforeCommit = async () => {
      if (injected) return;
      injected = true;
      await recordMissedFeedsHealth(memory as unknown as Firestore, result, NOW_US + 1000);
    };
    const older = { ...result, complete: false, errors: ['older-failure'] };
    expect(await recordMissedFeedsHealth(memory as unknown as Firestore, older, NOW_US)).toBe(
      false,
    );
    expect(memory.docs(HEALTH_PATH).get('app-' + APP_ID)).toMatchObject({
      complete: true,
      lastSweepAtUs: NOW_US + 1000,
      lastSuccessAtUs: NOW_US + 1000,
      lastError: null,
    });
  });
  it('validates sites and retains the daily retention invariant', () => {
    expect(missedFeedsSites()).toEqual(['MLB']);
    expect(missedFeedsSites('MLB, MLA,MLB')).toEqual(['MLB', 'MLA']);
    expect(missedFeedsSites('MCO,MPE')).toEqual(['MCO', 'MPE']);
    expect(() => missedFeedsSites('MLB,,MLA')).toThrow();
    expect(() => missedFeedsSites('MLB&offset=3')).toThrow();
    expect(MISSED_FEEDS_RETENTION_HOURS).toBe(48);
    expect(24 * 2).toBeLessThanOrEqual(MISSED_FEEDS_RETENTION_HOURS);
  });
});

describe('runMissedFeedsSweep — #812 acceptance: a deliberately dropped notification is recovered', () => {
  it.each([
    { topic: 'payments', resource: '/payments/1234567890', runner: 'paymentImportRunner' as const },
    {
      topic: 'orders_v2',
      resource: '/orders/2000009876543210',
      runner: 'orderImportRunner' as const,
    },
  ])('recovers a dropped $topic notification end to end', async ({ topic, resource, runner }) => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();

    // (1) THE DROP. ML never got a 200, so nothing was ever persisted — and the
    // pre-existing reprocess backstop demonstrably cannot see it. Without this
    // half, "recovered" is indistinguishable from "delivered normally".
    const before = await reprocessNotifications(db as unknown as Firestore);
    expect(before.processed).toBe(0);

    // (2) RECOVERY. ML files the failed delivery; the sweep replays it.
    wireApi({ 'INT-A': [page([feed({ _id: 'dropped-1', topic, resource })])] });
    const res = await run(db, scheduler);
    expect(res.streams[1]).toMatchObject({ found: 1, enqueued: 1, error: null });
    const recovered = enqueue.mock.calls[0]![0] as unknown as Record<string, unknown>;

    // (3) THE PAYLOAD IS ACTUALLY CONSUMABLE. Feeding it to the REAL task
    // handler is what makes this evidence rather than a tautology: it proves
    // the payload clears `mlNotificationTaskSchema` on the far side of the
    // Cloud Tasks wire, which `enqueue.toHaveBeenCalledWith` cannot.
    const importSpy = vi.fn(async () => ({ skipped: null }));
    const result = await handleNotificationTask(db as unknown as Firestore, recovered, 0, {
      [runner]: importSpy,
    });

    expect(result).toMatchObject({ outcome: 'done', integracaoId: 'INT-A', topic });
    expect(importSpy).toHaveBeenCalledWith(
      expect.anything(),
      'INT-A',
      Number(resource.split('/').pop()),
    );
    // A clean recovery persists NOTHING — the failures-only store stays empty.
    expect(db.docs('notificacoesMercadoLivre').size).toBe(0);
  });
});
