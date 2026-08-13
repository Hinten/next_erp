/**
 * #824 / ADR 0011 tier 1 — the registro route must not revert a token that was
 * stored while it was blocked on the Meta Graph `register` call.
 *
 * The shape, before the fix:
 *
 *   T1  POST /registro  reads `existing.permanent_token = TKN_OLD`
 *   T2                  …blocks on Graph `register` (seconds)…
 *   T3  POST /token     commits `permanent_token = TKN_NEW`
 *   T4  POST /registro  `save({ ...existing, pin })` — a FULL-DOC replace, so
 *                       TKN_NEW is reverted to TKN_OLD
 *
 * That reversion is close to invisible: TKN_OLD is a well-formed string, so
 * `resolveToken()` succeeds and nothing throws until Graph answers 401 — which
 * `dispatchOutbound` treats as TERMINAL (`estadoEnvio = erro`), a state
 * `sweepStaleOutbound` never re-drives. One lost field parks the outbound
 * backlog.
 *
 * The FakeDb below is versioned and ENFORCES the `lastUpdateTime` precondition
 * rather than merely recording it — the distinction `apps/mercado-livre`'s
 * `publish.test.ts` / `import.test.ts` fakes already make for the
 * non-transactional spelling. A recording-only fake would let every assertion
 * here pass against the unfixed code.
 *
 * Transaction semantics come from the shared `OccEngine`
 * (`@delfrance/data/testing`), so this file models one thing and one thing only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OccEngine, type OccPrecondition, type OccTransaction } from '@delfrance/data/testing';

const COLL_PATH = 'integracao/i1/credenciaisWhatsapp';
const CURRENT_PATH = `${COLL_PATH}/current`;

const h = vi.hoisted(() => ({
  ref: vi.fn(),
  docRef: vi.fn(),
  parse: vi.fn((data: unknown) => data),
  parseRead: vi.fn((data: unknown) => data),
  docPath: vi.fn((_ctx: unknown, id: string) => `integracao/i1/credenciaisWhatsapp/${id}`),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  credenciaisWhatsappCollection: {
    ref: h.ref,
    docRef: h.docRef,
    parse: h.parse,
    parseRead: h.parseRead,
    docPath: h.docPath,
  },
}));

const { createCredentialStore } = await import('./credentialStore');

type Doc = Record<string, unknown>;

/** gRPC FAILED_PRECONDITION, the way the Admin SDK surfaces it. */
class FakeFailedPrecondition extends Error {
  readonly code = 9;
  constructor(path: string) {
    super(`FAILED_PRECONDITION: "${path}" changed since it was read`);
    this.name = 'FakeFailedPrecondition';
  }
}

/**
 * A versioned single-collection store. `version` is a monotonic counter
 * standing in for Firestore's `updateTime`; the store only ever compares it for
 * equality, which is all a precondition needs.
 */
class FakeDb {
  private readonly docs = new Map<string, Doc>();
  private readonly versions = new Map<string, number>();
  private clock = 0;

  readonly occ = new OccEngine({
    applyWrite: (kind, path, data, precondition) => {
      this.assertPrecondition(path, precondition);
      if (kind === 'update' && !this.docs.has(path)) {
        const err = new Error(`NOT_FOUND: ${path}`) as Error & { code: number };
        err.code = 5;
        throw err;
      }
      if (kind === 'update') this.docs.set(path, { ...this.docs.get(path), ...data });
      else this.docs.set(path, { ...data });
      this.versions.set(path, (this.clock += 1));
    },
    applyDelete: (path, precondition) => {
      this.assertPrecondition(path, precondition);
      this.docs.delete(path);
      this.versions.delete(path);
    },
  });

  private assertPrecondition(path: string, precondition?: OccPrecondition): void {
    if (precondition?.lastUpdateTime === undefined) return;
    if (this.versions.get(path) !== precondition.lastUpdateTime) {
      throw new FakeFailedPrecondition(path);
    }
  }

  /** Write outside any transaction — the competing `/api/whatsapp/token` POST. */
  commitAsOtherWriter(path: string, doc: Doc): void {
    this.docs.set(path, { ...doc });
    this.versions.set(path, (this.clock += 1));
  }

  read(path: string): Doc | undefined {
    return this.docs.get(path);
  }

  docRef(path: string) {
    return {
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      get: async () => {
        const data = this.docs.get(path);
        return {
          exists: data !== undefined,
          updateTime: this.versions.get(path),
          data: () => data,
        };
      },
    };
  }

  collRef(path: string) {
    return {
      path,
      get: async () => ({
        docs: [...this.docs.entries()]
          .filter(([p]) => p.startsWith(`${path}/`))
          .map(([p, data]) => ({
            id: p.slice(p.lastIndexOf('/') + 1),
            ref: this.docRef(p),
            data: () => data,
          })),
      }),
    };
  }

  async runTransaction<T>(fn: (tx: OccTransaction) => Promise<T>): Promise<T> {
    return this.occ.runTransaction(fn);
  }
}

const TKN_OLD = 'TKN_OLD';
const TKN_NEW = 'TKN_NEW';

function seed(db: FakeDb): void {
  db.commitAsOtherWriter(CURRENT_PATH, {
    permanent_token: TKN_OLD,
    phoneNumberId: 'PID',
    wa_id: 'PID',
    pin: null,
    createdAt: 1,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.parse.mockImplementation((data: unknown) => data);
  h.parseRead.mockImplementation((data: unknown) => data);
  h.docPath.mockImplementation((_ctx: unknown, id: string) => `${COLL_PATH}/${id}`);
});

describe('credentialStore tier-1 precondition (#824)', () => {
  it('loadForUpdate() hands back the version the write-back must be checked against', async () => {
    const db = new FakeDb();
    seed(db);
    h.docRef.mockImplementation(() => db.docRef(CURRENT_PATH));

    const store = createCredentialStore(db as never, 'i1');
    const stored = await store.loadForUpdate();

    expect(stored?.cred).toMatchObject({ permanent_token: TKN_OLD });
    expect(stored?.version).toBeDefined();
  });

  it('loadForUpdate() returns null when there is no credential', async () => {
    const db = new FakeDb();
    h.docRef.mockImplementation(() => db.docRef(CURRENT_PATH));

    const store = createCredentialStore(db as never, 'i1');
    expect(await store.loadForUpdate()).toBeNull();
  });

  it('rejects a write-back derived from a read another writer has since overtaken', async () => {
    const db = new FakeDb();
    seed(db);
    h.ref.mockImplementation(() => db.collRef(COLL_PATH));
    h.docRef.mockImplementation(() => db.docRef(CURRENT_PATH));

    const store = createCredentialStore(db as never, 'i1');
    // T1 — the registro route reads before its Graph round-trip.
    const stored = await store.loadForUpdate();
    // T3 — POST /api/whatsapp/token lands while registro is blocked on Graph.
    db.commitAsOtherWriter(CURRENT_PATH, { ...stored!.cred, permanent_token: TKN_NEW });

    // T4 — the stale write-back. This is the call that used to silently revert.
    await expect(
      store.save({ ...stored!.cred, pin: '123456' }, { expectedVersion: stored!.version }),
    ).rejects.toMatchObject({ code: 9 });

    expect(db.read(CURRENT_PATH)).toMatchObject({ permanent_token: TKN_NEW });
  });

  it('without a precondition the same sequence silently reverts the token', async () => {
    // The negative control. It pins WHY the argument is load-bearing: this is
    // exactly what the registro route did before #824, and it passes silently.
    const db = new FakeDb();
    seed(db);
    h.ref.mockImplementation(() => db.collRef(COLL_PATH));
    h.docRef.mockImplementation(() => db.docRef(CURRENT_PATH));

    const store = createCredentialStore(db as never, 'i1');
    const stored = await store.loadForUpdate();
    db.commitAsOtherWriter(CURRENT_PATH, { ...stored!.cred, permanent_token: TKN_NEW });

    await store.save({ ...stored!.cred, pin: '123456' });

    expect(db.read(CURRENT_PATH)).toMatchObject({ permanent_token: TKN_OLD });
  });

  it('a conditional write commits normally when nobody raced it', async () => {
    const db = new FakeDb();
    seed(db);
    h.ref.mockImplementation(() => db.collRef(COLL_PATH));
    h.docRef.mockImplementation(() => db.docRef(CURRENT_PATH));

    const store = createCredentialStore(db as never, 'i1');
    const stored = await store.loadForUpdate();
    await store.save({ ...stored!.cred, pin: '123456' }, { expectedVersion: stored!.version });

    expect(db.read(CURRENT_PATH)).toMatchObject({
      permanent_token: TKN_OLD,
      pin: '123456',
    });
  });

  it('still deletes stray docs on the conditional path (single-token invariant)', async () => {
    const db = new FakeDb();
    seed(db);
    db.commitAsOtherWriter(`${COLL_PATH}/legacy-auto-id`, { permanent_token: 'STRAY' });
    h.ref.mockImplementation(() => db.collRef(COLL_PATH));
    h.docRef.mockImplementation(() => db.docRef(CURRENT_PATH));

    const store = createCredentialStore(db as never, 'i1');
    const stored = await store.loadForUpdate();
    await store.save({ ...stored!.cred, pin: '123456' }, { expectedVersion: stored!.version });

    // The precondition must not cost the single-token invariant: at most one
    // credential ever lives, so the stray goes with the conditional write.
    expect(db.read(`${COLL_PATH}/legacy-auto-id`)).toBeUndefined();
    expect(db.read(CURRENT_PATH)).toMatchObject({ pin: '123456' });
  });
});
