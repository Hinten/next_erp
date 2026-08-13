import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
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

const h = vi.hoisted(() => ({
  loadCtx: vi.fn(),
  createApi: vi.fn(),
}));

// The sweep builds its ML API via the exact consumer chain
// (loadMercadoLivreContext → resolveChannelContext → createMercadoLivreApi);
// both seams are mocked PARTIALLY so the error classes stay real and
// `instanceof` keeps working in the containment boundary.
vi.mock('./mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('./mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});
vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-livre')>();
  return { ...actual, createMercadoLivreApi: h.createApi };
});

import {
  APP_ID_INVALIDO_ERROR,
  MAX_PAGES_PER_TICK,
  MISSED_FEEDS_FLAG_ENV,
  MISSED_FEEDS_RETENTION_HOURS,
  PAGE_LIMIT,
  runMissedFeedsSweep,
} from './missedFeedsSweep';
import { KNOWN_TOPICS, handleNotificationTask, reprocessNotifications } from './notificacao';

/* ------------------------------ fake Firestore ---------------------------- */
// Trimmed copy of orderBackfill.test.ts's FakeDb, plus `orderBy` (the shared
// notification sweep's `pending` query uses it) so the acceptance test can call
// the REAL `reprocessNotifications`.

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

/* --------------------------------- helpers -------------------------------- */

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

/**
 * Wire the mocked context→api chain. `pagesByConta` maps an integracaoId to the
 * pages it should serve, in order; anything past the end serves an empty page.
 *
 * ⚠️ Deliberately NOT `mockResolvedValueOnce` — a queued `...Once` survives
 * `vi.clearAllMocks()` and leaks into the next test. An explicit counter per
 * conta cannot.
 */
function wireApi(pagesByConta: Record<string, MlMissedFeeds[]>): {
  getMissedFeeds: ReturnType<typeof vi.fn>;
} {
  const calls: Record<string, number> = {};
  let current = 'unknown';
  const getMissedFeeds = vi.fn(async (params: { appId: string; offset?: number }) => {
    void params;
    const n = (calls[current] = (calls[current] ?? 0) + 1);
    return pagesByConta[current]?.[n - 1] ?? page([]);
  });

  h.loadCtx.mockImplementation(async (_db: Firestore, integracaoId: string) => {
    current = integracaoId;
    return {
      integracaoId,
      conta: {},
      channel: {},
      store: {},
      resolveChannelContext: async () => {
        current = integracaoId;
        return { integracaoId, accessToken: `tok-${integracaoId}`, account: {} };
      },
      exchangeAndPersist: async () => {},
    };
  });
  h.createApi.mockReturnValue({ getMissedFeeds } as unknown as MercadoLivreApi);
  return { getMissedFeeds };
}

function run(db: FakeDb, scheduler: MlTaskScheduler) {
  return runMissedFeedsSweep(db as unknown as Firestore, { scheduler, nowMs: NOW_MS });
}

beforeEach(() => {
  process.env[MISSED_FEEDS_FLAG_ENV] = '1';
  process.env.MERCADO_LIVRE_CLIENT_ID = APP_ID;
  h.loadCtx.mockReset();
  h.createApi.mockReset();
  // ⚠️ NOT `vi.useFakeTimers({ now: NOW_MS })`. Anchoring the system clock to
  // the SAME instant as the injected `nowMs` would hide a stray `Date.now()` —
  // the exact bug the injection exists to prevent. Anchoring it 12h WRONG makes
  // any accidental read fail every `toEqual` on the health doc instead.
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS + 12 * 3600_000);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env[MISSED_FEEDS_FLAG_ENV];
  delete process.env.MERCADO_LIVRE_CLIENT_ID;
});

/* ---------------------------------- tests --------------------------------- */

describe('runMissedFeedsSweep — flag gate', () => {
  it('flag off → { enabled: false }, ZERO Firestore reads and ZERO enqueues', async () => {
    delete process.env[MISSED_FEEDS_FLAG_ENV];
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({});

    const res = await run(db, scheduler);

    expect(res).toEqual({
      enabled: false,
      configured: false,
      contas: [],
      topicosPulados: {},
      httpCodes: {},
      escopoAparente: 'indeterminado',
    });
    expect(db.opLog).toHaveLength(0);
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(['0', 'true', 'yes', ''])('flag set to %o stays off', async (value) => {
    process.env[MISSED_FEEDS_FLAG_ENV] = value;
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();

    const res = await run(db, scheduler);

    expect(res.enabled).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('runMissedFeedsSweep — preconditions', () => {
  it.each(['', '   ', 'abc', '0', '12x'])(
    'an unusable MERCADO_LIVRE_CLIENT_ID (%o) fails the TICK once, not once per conta',
    async (value) => {
      process.env.MERCADO_LIVRE_CLIENT_ID = value;
      const db = new FakeDb();
      seedConta(db, 'INT-A', SELLER);
      seedConta(db, 'INT-B', SELLER + 1);
      const { scheduler, enqueue } = makeScheduler();

      const res = await run(db, scheduler);

      expect(res).toMatchObject({ enabled: true, configured: false, contas: [] });
      // One misconfiguration must not write N per-conta error rows — that
      // buries the real signal under noise identical on every row.
      expect(db.docs(HEALTH_PATH).size).toBe(0);
      expect(h.loadCtx).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      expect(APP_ID_INVALIDO_ERROR).toContain('MERCADO_LIVRE_CLIENT_ID');
    },
  );

  it('enumerates active ML contas with ONLY the (tipo, ativo) clauses', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    db.seed(INTEGRACAO_PATH, 'INT-OFF', {
      tipo: INTEGRACAO_TIPO.mercadoLivre,
      ativo: false,
      user_id: 1,
    });
    db.seed(INTEGRACAO_PATH, 'INT-OTHER', { tipo: 'melhorEnvio', ativo: true, user_id: 2 });
    const { scheduler } = makeScheduler();
    wireApi({});

    const res = await run(db, scheduler);

    expect(res.contas.map((c) => c.integracaoId)).toEqual(['INT-A']);
    // Firestore Enterprise silently full-scans an unindexed query and bills the
    // scan. `(tipo, ativo)` is already in firestore.indexes.json — this pins
    // that no THIRD `where` sneaks in without a matching index. This feature
    // requires no new index.
    const enumQuery = db.queries[0]!;
    expect(enumQuery.clauses.map(([f]) => f)).toEqual(['tipo', 'ativo']);
  });

  it('a conta with NO user_id is still swept — only its scope probe is blind', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', null);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({ 'INT-A': [page([feed()])] });

    const res = await run(db, scheduler);

    // Unlike the order backfill (which needs `seller` for GET /orders/search),
    // missed_feeds needs only a token and the app id, and every entry carries
    // its own seller id. Refusing to sweep here would forfeit recovery for a
    // conta connected by the legacy Flutter app.
    expect(res.contas[0]).toMatchObject({ error: null, found: 1, enqueued: 1 });
    expect(res.contas[0]!.userIdEstranhos).toBe(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('runMissedFeedsSweep — topic filtering', () => {
  it('enqueues EVERY member of KNOWN_TOPICS (no private topic list)', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    const topics = [...KNOWN_TOPICS];
    wireApi({
      'INT-A': [page(topics.map((t, i) => feed({ _id: `f-${i}`, topic: t, resource: `/x/${i}` })))],
    });

    const res = await run(db, scheduler);

    // Anti-drift: if the sweep ever re-declares its own topic set instead of
    // importing the shared one, nothing else in the repo reds.
    expect(enqueue).toHaveBeenCalledTimes(topics.length);
    expect(res.contas[0]!.skippedTopic).toBe(0);
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
    expect(res.contas[0]).toMatchObject({ found: 3, novos: 3, enqueued: 2, skippedTopic: 1 });
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

  it('an entry with no _id still enqueues (id: null ⇒ an auto doc id if it fails)', async () => {
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
    expect(res.contas[0]).toMatchObject({ found: 1, enqueued: 0, skippedInvalid: 1 });
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
    expect(res.contas[0]!.userIdEstranhos).toBe(1);
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

describe('runMissedFeedsSweep — dedup', () => {
  it('the same _id twice in ONE page is enqueued once', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({ 'INT-A': [page([feed({ _id: 'dup' }), feed({ _id: 'dup' })])] });

    const res = await run(db, scheduler);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(res.contas[0]).toMatchObject({ found: 2, novos: 1, enqueued: 1 });
  });

  it('the same _id across TWO pages of one tick is enqueued once', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({
      'INT-A': [page([feed({ _id: 'dup' })]), page([feed({ _id: 'dup' })]), page([])],
    });

    await run(db, scheduler);

    // The `Set` must span the pagination loop, not reset per page.
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('the same _id served to TWO contas is enqueued once (app-wide response)', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    seedConta(db, 'INT-B', SELLER + 1);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({
      'INT-A': [page([feed({ _id: 'shared' })])],
      'INT-B': [page([feed({ _id: 'shared' })])],
    });

    const res = await run(db, scheduler);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(res.escopoAparente).toBe('app-wide');
  });

  it('an entry with no _id dedups on the topic|resource|sent composite', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({ 'INT-A': [page([feed({ _id: null }), feed({ _id: null })])] });

    await run(db, scheduler);

    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('runMissedFeedsSweep — pagination', () => {
  it('pages with advancing offsets and stops on an EMPTY page', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler, enqueue } = makeScheduler();
    const p1 = page([feed({ _id: 'a' }), feed({ _id: 'b' })]);
    const p2 = page([feed({ _id: 'c' })]);
    const { getMissedFeeds } = wireApi({ 'INT-A': [p1, p2, page([])] });

    const res = await run(db, scheduler);

    // ⚠️ Page 2 is SHORT (1 < PAGE_LIMIT) and must NOT end the loop: ML
    // documents no max `limit`, so a silent clamp would make every page short
    // and a short-page rule would under-read the feed silently.
    expect(getMissedFeeds).toHaveBeenCalledTimes(3);
    expect(getMissedFeeds).toHaveBeenNthCalledWith(1, {
      appId: APP_ID,
      limit: PAGE_LIMIT,
      offset: 0,
    });
    expect(getMissedFeeds).toHaveBeenNthCalledWith(2, {
      appId: APP_ID,
      limit: PAGE_LIMIT,
      offset: 2,
    });
    expect(getMissedFeeds).toHaveBeenNthCalledWith(3, {
      appId: APP_ID,
      limit: PAGE_LIMIT,
      offset: 3,
    });
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(res.contas[0]).toMatchObject({ found: 3, pages: 3, truncated: false });
  });

  it('the page cap truncates: loud warn, lastTruncated stamped, lastError still null', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler } = makeScheduler();
    const pages = Array.from({ length: MAX_PAGES_PER_TICK + 5 }, (_, i) =>
      page([feed({ _id: `f-${i}` })]),
    );
    const { getMissedFeeds } = wireApi({ 'INT-A': pages });
    const warn = vi.spyOn(console, 'warn');

    const res = await run(db, scheduler);

    expect(getMissedFeeds).toHaveBeenCalledTimes(MAX_PAGES_PER_TICK);
    expect(res.contas[0]).toMatchObject({ truncated: true, pages: MAX_PAGES_PER_TICK });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('missed-feeds TRUNCADO'),
      expect.objectContaining({ integracaoId: 'INT-A' }),
    );
    // Truncation is a CAPACITY signal, not an error.
    const doc = db.docs(HEALTH_PATH).get('INT-A')!;
    expect(doc.lastTruncated).toBe(true);
    expect(doc.lastError).toBeNull();
  });
});

describe('runMissedFeedsSweep — the health doc', () => {
  it('a clean sweep stamps the counters and clears lastError, using the INJECTED clock', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler } = makeScheduler();
    wireApi({
      'INT-A': [page([feed({ _id: 'a' }), feed({ _id: 'b', topic: 'topico_novo' })])],
    });

    await run(db, scheduler);

    // `toEqual`, not `toMatchObject` — the system clock is deliberately 12h off
    // in `beforeEach`, so a stray `Date.now()` anywhere in the sweep fails here.
    expect(db.docs(HEALTH_PATH).get('INT-A')).toEqual({
      lastSweepAtUs: NOW_US,
      lastError: null,
      lastFoundCount: 2,
      lastEnqueuedCount: 1,
      lastSkippedCount: 1,
      lastTruncated: false,
    });
  });

  it('the retention invariant is documented alongside the daily schedule', () => {
    // 24h × 2 ≤ 48h. If someone moves the cron to weekly, this constant is what
    // the reviewer must be sent back to (the cron literal itself is asserted in
    // functions/src/index.test.ts).
    expect(MISSED_FEEDS_RETENTION_HOURS).toBe(48);
    expect(24 * 2).toBeLessThanOrEqual(MISSED_FEEDS_RETENTION_HOURS);
  });
});

describe('runMissedFeedsSweep — per-conta failure isolation', () => {
  it('a MercadoLivreHttpError on conta A is contained; conta B still fully runs', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    seedConta(db, 'INT-B', SELLER + 1);
    const { scheduler, enqueue } = makeScheduler();
    wireApi({ 'INT-B': [page([feed({ _id: 'b1' })])] });
    const failing = vi.fn(async (params: { appId: string }) => {
      void params;
      throw new MercadoLivreHttpError('ML 500: boom', 500, null);
    });
    const okApi = { getMissedFeeds: vi.fn(async () => page([feed({ _id: 'b1' })])) };
    h.createApi.mockImplementation(
      ({ getAccessToken }: { getAccessToken: () => Promise<string> }) =>
        // The token is `tok-<integracaoId>`, so it identifies the conta.
        ({
          getMissedFeeds: async (p: { appId: string; offset?: number }) => {
            const tok = await getAccessToken();
            if (tok === 'tok-INT-A') return failing(p);
            return (p.offset ?? 0) === 0 ? okApi.getMissedFeeds() : page([]);
          },
        }) as unknown as MercadoLivreApi,
    );

    const res = await run(db, scheduler);

    expect(res.contas[0]).toMatchObject({ integracaoId: 'INT-A', error: 'ML 500: boom' });
    expect(res.contas[1]).toMatchObject({ integracaoId: 'INT-B', error: null, enqueued: 1 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    // The contained conta gets lastError WITHOUT the counters — a stale count
    // must never read as this run's.
    expect(db.docs(HEALTH_PATH).get('INT-A')).toEqual({
      lastSweepAtUs: NOW_US,
      lastError: 'ML 500: boom',
    });
  });

  it('MlTasksDisabledError from the enqueue is contained', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const scheduler: MlTaskScheduler = {
      enqueue: vi.fn<MlTaskScheduler['enqueue']>(async () => {
        throw new MlTasksDisabledError();
      }),
    };
    wireApi({ 'INT-A': [page([feed()])] });

    const res = await run(db, scheduler);

    expect(res.contas[0]!.error).toContain('MERCADO_LIVRE_TASKS_DISABLED');
    // No persistNotificationFailure fallback here, deliberately: unlike the
    // receiver (which must never 5xx or ML disables the topic), the sweep has
    // no such pressure and the entry survives in the feed for 2 days.
    expect(db.docs(HEALTH_PATH).get('INT-A')!.lastError).toContain('TASKS_DISABLED');
  });

  it('a gRPC-coded transport error (code 1–16) is contained', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler } = makeScheduler();
    wireApi({});
    h.loadCtx.mockImplementation(async () => {
      const err = new Error('DEADLINE_EXCEEDED') as Error & { code: number };
      err.code = 4;
      throw err;
    });

    const res = await run(db, scheduler);

    expect(res.contas[0]!.error).toBe('DEADLINE_EXCEEDED');
  });

  it('an Error with a numeric code OUTSIDE 1–16 RETHROWS', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler } = makeScheduler();
    h.loadCtx.mockImplementation(async () => {
      const err = new Error('bug') as Error & { code: number };
      err.code = 42;
      throw err;
    });

    await expect(run(db, scheduler)).rejects.toThrow('bug');
  });

  it('an unclassifiable Error (a coding bug) RETHROWS and records nothing', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', SELLER);
    const { scheduler } = makeScheduler();
    h.loadCtx.mockImplementation(async () => {
      throw new TypeError('x is not a function');
    });

    await expect(run(db, scheduler)).rejects.toThrow('x is not a function');
    // The whole point of the containment boundary's rethrow arm: fail the tick
    // loudly instead of burying a bug in a per-conta error entry.
    expect(db.docs(HEALTH_PATH).size).toBe(0);
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
    expect(res.contas[0]).toMatchObject({ found: 1, enqueued: 1, error: null });
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
