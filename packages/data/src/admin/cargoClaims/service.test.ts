import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessAuth as Auth } from './claims';
class FirebaseAuthError extends Error {
  code: string;
  constructor(input: { code: string; message: string }) {
    super(input.message);
    this.code = input.code;
  }
}
const AuthErrorCode = {
  USER_NOT_FOUND: 'auth/user-not-found',
  INTERNAL_ERROR: 'auth/internal-error',
};
import { PERM } from '@delfrance/auth';
import {
  ACCESS_ACTION as A,
  ACCESS_PHASE as P,
  SUPERUSER_MASK,
  cargoSchema,
  usuarioSchema,
  type AccessCommand,
} from '@delfrance/schemas';
// Minimal deterministic Firestore seam for exercising the real coordinator.
// Tests stage writes until commit; failures discard the whole transaction.
import type { Firestore } from 'firebase-admin/firestore';
export function memoryFirestore() {
  const rows = new Map<string, { value: Record<string, unknown>; version: number }>();
  let revision = 0;
  let rejectCommit = false;
  const reads: { path: string; limit: number }[] = [];
  function seed(path: string, value: Record<string, unknown>) {
    rows.set(path, { value: structuredClone(value), version: ++revision });
  }
  function snap(path: string) {
    const row = rows.get(path);
    return {
      id: path.split('/').at(-1)!,
      exists: !!row,
      data: () => (row ? structuredClone(row.value) : undefined),
      updateTime: row ? { seconds: row.version, nanoseconds: 0 } : undefined,
    };
  }
  function ref(path: string) {
    return { path, get: async () => snap(path) };
  }
  function collection(
    path: string,
    filter?: { key: string; value: unknown },
    cursor = '',
    take = Infinity,
  ): unknown {
    const query = {
      path,
      doc: (id: string) => ref(path + '/' + id),
      where: (key: string, _operator: string, value: unknown) =>
        collection(path, { key, value }, cursor, take),
      orderBy: () => collection(path, filter, cursor, take),
      startAfter: (value: string) => collection(path, filter, value, take),
      limit: (size: number) => collection(path, filter, cursor, size),
      get: async () => {
        reads.push({ path, limit: take });
        const docs = [...rows.keys()]
          .filter(
            (key) =>
              key.startsWith(path + '/') && key.split('/').length === path.split('/').length + 1,
          )
          .filter((key) => key.split('/').at(-1)! > cursor)
          .sort()
          .filter((key) => {
            const raw = rows.get(key)!.value[filter?.key ?? ''];
            return !filter || (Array.isArray(raw) && raw.includes(filter.value));
          })
          .slice(0, take)
          .map(snap);
        return { docs, size: docs.length };
      },
    };
    return query;
  }
  const db = {
    collection,
    getAll: async (...refs: { path: string }[]) => refs.map((r) => snap(r.path)),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      const writes: (() => void)[] = [];
      const tx = {
        get: async (r: { get?: () => Promise<unknown>; path: string }) =>
          r.get ? r.get() : snap(r.path),
        getAll: async (...refs: { path: string }[]) => refs.map((r) => snap(r.path)),
        create: (r: { path: string }, v: Record<string, unknown>) =>
          writes.push(() => seed(r.path, v)),
        set: (r: { path: string }, v: Record<string, unknown>) =>
          writes.push(() => seed(r.path, v)),
        update: (r: { path: string }, v: Record<string, unknown>) =>
          writes.push(() => seed(r.path, { ...rows.get(r.path)!.value, ...v })),
        delete: (r: { path: string }) =>
          writes.push(() => {
            rows.delete(r.path);
          }),
      };
      const result = await fn(tx);
      if (rejectCommit) {
        rejectCommit = false;
        throw new TypeError('injected commit failure');
      }
      writes.forEach((write) => write());
      return result;
    },
  } as unknown as Firestore;
  return {
    db,
    seed,
    reads,
    get: (path: string) => rows.get(path)?.value,
    version: (path: string) => (rows.has(path) ? rows.get(path)!.version + ':0' : null),
    failNextCommit: () => {
      rejectCommit = true;
    },
  };
}

import {
  getAccessOperation,
  processAccessOperation,
  startAccessOperation,
  retryAccessOperation,
} from './service';
import { LEASE_MS } from './model';

const CONFIG = PERM.configuracoes.read | PERM.configuracoes.write;
const role = (bits = 1n) =>
  cargoSchema.parse({ nome: 'Cargo', descricao: null, permissoes: bits.toString() });
const user = (extra: Record<string, unknown> = {}) =>
  usuarioSchema.parse({ nome: 'Pessoa', cargos: ['role'], colaborador: true, ...extra });
let store: ReturnType<typeof memoryFirestore>;
let accounts: Map<
  string,
  { uid: string; disabled: boolean; customClaims: Record<string, unknown> }
>;
let auth: Auth;
let write: ReturnType<
  typeof vi.fn<(uid: string, claims: Record<string, unknown>) => Promise<void>>
>;
let clock: number;

beforeEach(() => {
  vi.restoreAllMocks();
  clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  store = memoryFirestore();
  accounts = new Map();
  store.seed('cargos/role', role());
  store.seed('cargos/admin', role(CONFIG));
  store.seed('usuarios/actor', user({ cargos: ['admin'], isSuperUser: true }));
  accounts.set('actor', { uid: 'actor', disabled: false, customClaims: {} });
  write = vi.fn(async (uid: string, claims: Record<string, unknown>) => {
    const account = accounts.get(uid);
    if (!account)
      throw new FirebaseAuthError({ code: AuthErrorCode.USER_NOT_FOUND, message: 'gone' });
    account.customClaims = claims;
  });
  auth = {
    errorType: FirebaseAuthError,
    getUser: vi.fn(async (uid: string) => {
      const account = accounts.get(uid);
      if (!account)
        throw new FirebaseAuthError({ code: AuthErrorCode.USER_NOT_FOUND, message: 'gone' });
      return structuredClone(account);
    }),
    getUsers: vi.fn(async (ids: { uid: string }[]) => ({
      users: ids.flatMap(({ uid }) =>
        accounts.has(uid) ? [structuredClone(accounts.get(uid)!)] : [],
      ),
    })),
    setCustomUserClaims: write,
  } as unknown as Auth;
});
function holder(id: string, extra: Record<string, unknown> = {}, withAuth = true) {
  store.seed('usuarios/' + id, user(extra));
  if (withAuth)
    accounts.set(id, {
      uid: id,
      disabled: false,
      customClaims: { permissions: '1', su: false, d_cliente: 1, grupoEconomico: 'display' },
    });
}
async function start(
  id = 'op',
  value = role(3n),
  action: AccessCommand['action'] = A.updateCargo,
  ceiling = SUPERUSER_MASK,
) {
  return startAccessOperation(store.db, {
    id,
    actorId: 'actor',
    tokenBits: ceiling,
    command: {
      action,
      targetId: 'role',
      expectedVersion: store.version('cargos/role'),
      cargo: action === A.deleteCargo ? null : value,
      usuario: null,
    },
  });
}
async function tick(id = 'op') {
  await processAccessOperation(store.db, auth, id);
  return getAccessOperation(store.db, id);
}
async function finish(id = 'op') {
  for (let i = 0; i < 100; i++) {
    const op = await tick(id);
    if (op.phase === P.completed || op.phase === P.rejected || op.phase === P.failed) return op;
  }
  throw new Error('did not finish');
}

describe('access operation coordinator', () => {
  it('validates every page before mutating, then propagates every holder in bounded batches', async () => {
    for (let i = 0; i < 205; i++) holder('u' + String(i).padStart(3, '0'));
    await start();
    for (let i = 0; i < 3; i++) {
      const op = await tick();
      expect(op.phase).toBe(P.validating);
      expect(store.get('cargos/role')?.permissoes).toBe('1');
      expect(write).not.toHaveBeenCalled();
    }
    expect((await tick()).phase).toBe(P.applying);
    const op = await finish();
    expect(op.processed).toBe(205);
    expect(op.updated).toBe(205);
    expect(accounts.get('u204')?.customClaims).toMatchObject({
      permissions: '3',
      d_cliente: 3,
      grupoEconomico: 'display',
    });
    expect(store.reads.filter((r) => r.path === 'usuarios').every((r) => r.limit <= 100)).toBe(
      true,
    );
    expect(store.get('accessControl/current')?.activeId).toBeNull();
  });
  it('rejects an overprivileged holder on the last page without any source or Auth mutation', async () => {
    for (let i = 0; i < 100; i++) holder('u' + String(i).padStart(3, '0'));
    store.seed('usuarios/actor', user({ cargos: ['admin'] }));
    store.seed('cargos/admin', role(CONFIG | 3n));
    store.seed('cargos/extra', role(8n));
    holder('z', { cargos: ['role', 'extra'] });
    await start('op', role(3n), A.updateCargo, CONFIG | 3n);
    const op = await finish();
    expect(op.phase).toBe(P.rejected);
    expect(op.errorCode).toBe('CASCADE_PERMISSION');
    expect(store.get('cargos/role')?.permissoes).toBe('1');
    expect(write).not.toHaveBeenCalled();
  });
  it('revokes inactive/non-collaborator/disabled accounts, skips contacts and missing Auth, accepts missing email', async () => {
    holder('active', { email: null });
    holder('inactive', { ativo: false });
    holder('outsider', { colaborador: false });
    holder('disabled');
    accounts.get('disabled')!.disabled = true;
    holder('external', { externalId: 'contact' }, false);
    holder('missing', {}, false);
    await start();
    const op = await finish();
    expect(op.processed).toBe(6);
    expect(op.external).toBe(1);
    expect(op.missing).toBe(1);
    for (const id of ['inactive', 'outsider', 'disabled']) {
      expect(accounts.get(id)?.customClaims.permissions).toBe('0');
      expect(accounts.get(id)?.customClaims).not.toHaveProperty('d_cliente');
    }
    expect(accounts.get('active')?.customClaims.permissions).toBe('3');
    expect(auth.getUser).not.toHaveBeenCalledWith('external');
    expect(accounts.get('disabled')?.disabled).toBe(true);
  });
  it('deletion retains other cargo permissions and dangling references', async () => {
    store.seed('cargos/other', role(4n));
    holder('u', { cargos: ['role', 'other', 'ghost'] });
    await start('op', role(), A.deleteCargo);
    expect((await finish()).phase).toBe(P.completed);
    expect(store.get('cargos/role')).toBeUndefined();
    expect(accounts.get('u')?.customClaims.permissions).toBe('4');
    expect(store.get('usuarios/u')?.cargos).toEqual(['role', 'other', 'ghost']);
  });
  it('does not block an accepted self-demotion on the actor losing write permission', async () => {
    store.seed('usuarios/actor', user());
    store.seed('cargos/role', role(CONFIG | 1n));
    await start('op', role(1n), A.updateCargo, CONFIG | 1n);
    expect((await finish()).phase).toBe(P.completed);
    expect(accounts.get('actor')?.customClaims.permissions).toBe('1');
  });
  it('intersects current actor permissions with stale claims', async () => {
    store.seed('usuarios/actor', user({ cargos: [] }));
    await expect(start()).rejects.toMatchObject({ code: 'ACTOR_PERMISSION' });
    expect(store.get('accessControl/current')).toBeUndefined();
  });
  it('preserves the superuser guard, including inactive superusers', async () => {
    store.seed('usuarios/actor', user({ cargos: ['admin'] }));
    holder('super', { isSuperUser: true, ativo: false });
    await start('op', role(0n), A.updateCargo, CONFIG);
    expect((await finish()).phase).toBe(P.rejected);
  });
  it('idempotency is durable and bound to command and actor', async () => {
    const op = await start();
    expect((await start()).id).toBe(op.id);
    await expect(start('op', role(2n))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(start('other')).rejects.toMatchObject({ code: 'ACCESS_BUSY', operationId: 'op' });
    await finish();
    expect(await getAccessOperation(store.db, 'op')).toMatchObject({ phase: P.completed });
  });
  it('blocks user edits and manual refresh while a cargo operation owns the slot', async () => {
    holder('u');
    await start();
    for (const action of [A.updateUser, A.refreshUser]) {
      await expect(
        startAccessOperation(store.db, {
          id: action,
          actorId: 'actor',
          tokenBits: SUPERUSER_MASK,
          command: {
            action,
            targetId: 'u',
            expectedVersion: store.version('usuarios/u'),
            cargo: null,
            usuario: action === A.updateUser ? user() : null,
          },
        }),
      ).rejects.toMatchObject({ code: 'ACCESS_BUSY' });
    }
  });
  it('rejects a stale editor version', async () => {
    await expect(
      startAccessOperation(store.db, {
        id: 'op',
        actorId: 'actor',
        tokenBits: SUPERUSER_MASK,
        command: {
          action: A.updateCargo,
          targetId: 'role',
          expectedVersion: 'old',
          cargo: role(3n),
          usuario: null,
        },
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('does not repeat claims on duplicate deliveries or exact page-size boundaries', async () => {
    for (let i = 0; i < 100; i++) holder('u' + String(i).padStart(3, '0'));
    await start();
    await finish();
    await tick();
    expect(write).toHaveBeenCalledTimes(100);
    expect((await getAccessOperation(store.db, 'op')).processed).toBe(100);
  });
  it('replays an Auth success whose Firestore checkpoint failed without re-minting', async () => {
    holder('u');
    await start();
    await tick();
    await tick();
    write.mockImplementationOnce(async (uid: string, claims: Record<string, unknown>) => {
      accounts.get(uid)!.customClaims = claims;
      store.failNextCommit();
    });
    await expect(tick()).rejects.toThrow('injected commit failure');
    expect((await getAccessOperation(store.db, 'op')).processed).toBe(0);
    expect((await tick()).processed).toBe(0); // owned lease: duplicate cannot run
    clock += LEASE_MS + 1;
    expect((await finish()).phase).toBe(P.completed);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('records partial application failure, keeps the global lock and supports explicit retry', async () => {
    holder('a');
    holder('b');
    await start();
    await tick();
    await tick();
    write.mockImplementation(async (uid: string, claims: Record<string, unknown>) => {
      if (uid === 'b')
        throw new FirebaseAuthError({ code: AuthErrorCode.INTERNAL_ERROR, message: 'temporary' });
      accounts.get(uid)!.customClaims = claims;
    });
    expect((await finish()).phase).toBe(P.failed);
    expect(store.get('accessControl/current')?.activeId).toBe('op');
    write.mockImplementation(async (uid: string, claims: Record<string, unknown>) => {
      accounts.get(uid)!.customClaims = claims;
    });
    await retryAccessOperation(store.db, 'op', 'actor', SUPERUSER_MASK);
    expect((await finish()).phase).toBe(P.completed);
  });
  it('counts Auth deletion between preflight and application', async () => {
    holder('u');
    await start();
    await tick();
    await tick();
    accounts.delete('u');
    expect((await finish()).missing).toBe(1);
  });
  it('rejects an oversized final claims payload before mutation', async () => {
    holder('u');
    accounts.get('u')!.customClaims.large = 'x'.repeat(1000);
    await start();
    expect((await finish()).errorCode).toBe('CLAIMS_TOO_LARGE');
    expect(store.get('cargos/role')?.permissoes).toBe('1');
    expect(write).not.toHaveBeenCalled();
  });
});

it('accepts legacy non-authorization fields but rejects malformed authorization', async () => {
  holder('u');
  store.seed('usuarios/u', { ...store.get('usuarios/u'), email: 17, legacy: { untouched: true } });
  await start();
  expect((await finish()).phase).toBe(P.completed);
  store.seed('usuarios/u', { ...store.get('usuarios/u'), ativo: 'yes' });
  await start('invalid');
  expect((await finish('invalid')).errorCode).toBe('INVALID_AUTHORIZATION_DATA');
});
it('parks repeated unknown worker crashes without releasing a committed operation', async () => {
  holder('u');
  await start();
  await tick();
  await tick();
  vi.mocked(auth.getUser).mockRejectedValue(new TypeError('crash'));
  for (let i = 0; i < 5; i++) {
    await expect(tick()).rejects.toThrow('crash');
    clock += LEASE_MS + 1;
  }
  expect((await tick()).phase).toBe(P.failed);
  expect(store.get('accessControl/current')?.activeId).toBe('op');
});
it('user edits validate disabled accounts before source mutation and revoke their claims', async () => {
  holder('u');
  accounts.get('u')!.disabled = true;
  store.seed('usuarios/actor', user({ cargos: ['admin'] }));
  await startAccessOperation(store.db, {
    id: 'op',
    actorId: 'actor',
    tokenBits: CONFIG,
    command: {
      action: A.updateUser,
      targetId: 'u',
      expectedVersion: store.version('usuarios/u'),
      cargo: null,
      usuario: user({ nome: 'Updated' }),
    },
  });
  await tick();
  expect(store.get('usuarios/u')?.nome).toBe('Pessoa');
  expect((await finish()).phase).toBe(P.completed);
  expect(store.get('usuarios/u')?.nome).toBe('Updated');
  expect(accounts.get('u')?.customClaims.permissions).toBe('0');
});
it('a stale delivery cannot touch the next operation', async () => {
  await start();
  await finish();
  await start('next', role(7n));
  await tick('op');
  expect((await getAccessOperation(store.db, 'next')).cursor).toBeNull();
  expect(store.get('accessControl/current')?.activeId).toBe('next');
});
it('rejects an actor demoted between validation pages and source commit', async () => {
  holder('u');
  await start();
  await tick();
  store.seed('usuarios/actor', user({ cargos: ['admin'] }));
  expect((await tick()).phase).toBe(P.rejected);
  expect(store.get('cargos/role')?.permissoes).toBe('1');
  expect(write).not.toHaveBeenCalled();
});

it('recovers provisioned creation without persisting a password', async () => {
  await startAccessOperation(store.db, {
    id: 'op',
    actorId: 'actor',
    tokenBits: SUPERUSER_MASK,
    command: {
      action: A.createUser,
      targetId: 'new',
      expectedVersion: null,
      cargo: null,
      usuario: user({ email: 'new@example.test' }),
    },
  });
  expect((await tick()).phase).toBe(P.provisioning);
  expect(store.get('usuarios/new')).toBeUndefined();
  accounts.set('new', { uid: 'new', disabled: false, customClaims: {} });
  expect((await finish()).phase).toBe(P.completed);
  expect(store.get('usuarios/new')?.email).toBe('new@example.test');
  expect(accounts.get('new')?.customClaims.permissions).toBe('1');
  expect(store.get('accessOperations/op')?.command).not.toHaveProperty('senha');
});
it('releases an unprovisioned operation only after its creation window expired', async () => {
  await startAccessOperation(store.db, {
    id: 'op',
    actorId: 'actor',
    tokenBits: SUPERUSER_MASK,
    command: {
      action: A.createUser,
      targetId: 'new',
      expectedVersion: null,
      cargo: null,
      usuario: user({ email: 'new@example.test' }),
    },
  });
  clock += LEASE_MS + 1;
  expect((await tick()).errorCode).toBe('PROVISIONING_INCOMPLETE');
  expect(store.get('accessControl/current')?.activeId).toBeNull();
  expect(store.get('usuarios/new')).toBeUndefined();
});

it('lets a self-demoted original actor resume the already committed command', async () => {
  holder('u');
  await start();
  await tick();
  await tick();
  const pending = await getAccessOperation(store.db, 'op');
  store.seed('accessOperations/op', { ...pending, phase: P.failed });
  store.seed('usuarios/actor', user({ cargos: [], isSuperUser: false }));
  await retryAccessOperation(store.db, 'op', 'actor', 0n);
  expect((await finish()).phase).toBe(P.completed);
});
