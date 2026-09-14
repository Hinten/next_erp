import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthErrorCode, FirebaseAuthError } from 'firebase-admin/auth';
import { FirebaseAppError, AppErrorCode } from 'firebase-admin/app';
import { PERM } from '@delfrance/auth';
import { ACCESS_ACTION as A, cargoSchema } from '@delfrance/schemas';
const m = vi.hoisted(() => ({
  verify: vi.fn(),
  start: vi.fn(),
  get: vi.fn(),
  retry: vi.fn(),
  provision: vi.fn(),
  snapshot: vi.fn(),
  ceiling: vi.fn(),
}));
vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: m.verify }),
  getAdminFirestore: () => ({ collection: () => ({ doc: () => ({ get: m.snapshot }) }) }),
}));
vi.mock('@delfrance/data/admin/cargo-claims', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delfrance/data/admin/cargo-claims')>()),
  startAccessOperation: m.start,
  getAccessOperation: m.get,
  retryAccessOperation: m.retry,
  provisionAccessUser: m.provision,
  actorCeiling: m.ceiling,
}));
import { AccessError } from '@delfrance/data/admin/cargo-claims';
import { POST as createCargo } from '../app/api/admin/cargos/route';
import {
  PATCH as updateCargo,
  DELETE as deleteCargo,
  GET as readCargo,
} from '../app/api/admin/cargos/[id]/route';
import { POST as createUser } from '../app/api/admin/users/route';
import { POST as refresh } from '../app/api/admin/users/[uid]/claims/route';
import { PATCH as updateUser, GET as readUser } from '../app/api/admin/users/[uid]/route';
import { GET as readOperation } from '../app/api/admin/access-operations/[id]/route';
import { POST as retryOperation } from '../app/api/admin/access-operations/[id]/retry/route';

const ctx = { params: Promise.resolve({ id: 'role' }) };
const userCtx = { params: Promise.resolve({ uid: 'target' }) };
const role = cargoSchema.parse({ nome: 'Cargo', descricao: null, permissoes: '1' });
function req(body: unknown = {}, token = true) {
  return new Request('http://localhost/api/admin/cargos', {
    method: 'POST',
    headers: token ? { authorization: 'Bearer t', 'content-type': 'application/json' } : {},
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  m.verify.mockResolvedValue({
    uid: 'actor',
    permissions: (PERM.configuracoes.read | PERM.configuracoes.write).toString(),
  });
  m.start.mockResolvedValue({ id: 'op', phase: 'validating' });
  m.snapshot.mockResolvedValue({
    exists: true,
    data: () => role,
    updateTime: { seconds: 1, nanoseconds: 2 },
  });
});
describe('authenticated access routes', () => {
  it('requires a bearer token and checks revocation', async () => {
    expect((await createCargo(req({}, false))).status).toBe(401);
    expect(m.start).not.toHaveBeenCalled();
    await createCargo(req({ operationId: 'op', expectedVersion: null, cargo: role }));
    expect(m.verify).toHaveBeenCalledWith('t', true);
  });
  it.each([
    AuthErrorCode.ID_TOKEN_EXPIRED,
    AuthErrorCode.ID_TOKEN_REVOKED,
    AuthErrorCode.USER_DISABLED,
  ])('maps rejected token %s to 401', async (code) => {
    m.verify.mockRejectedValue(new FirebaseAuthError({ code, message: 'invalid' }));
    expect((await createCargo(req())).status).toBe(401);
  });
  it('maps Admin initialization failures and rethrows programming bugs', async () => {
    m.verify.mockRejectedValueOnce(
      new FirebaseAppError({ code: AppErrorCode.INVALID_CREDENTIAL, message: 'bad' }),
    );
    expect((await createCargo(req())).status).toBe(500);
    m.verify.mockRejectedValueOnce(new TypeError('bug'));
    await expect(createCargo(req())).rejects.toThrow('bug');
  });
  it('returns an accepted operation without claiming the cargo was saved', async () => {
    const response = await updateCargo(
      req({ operationId: 'op', expectedVersion: '1:2', cargo: role }),
      ctx,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ operationId: 'op', targetId: 'role' });
    expect(m.start.mock.calls[0]?.[1].command).toEqual({
      action: A.updateCargo,
      targetId: 'role',
      expectedVersion: '1:2',
      cargo: role,
      usuario: null,
    });
  });
  it('uses the same coordinator for creation, deletion and user edits', async () => {
    await createCargo(req({ operationId: 'op', expectedVersion: null, cargo: role }));
    expect(m.start.mock.calls.at(-1)?.[1].command.action).toBe(A.createCargo);
    await deleteCargo(req({ operationId: 'op', expectedVersion: '1:2' }), ctx);
    expect(m.start.mock.calls.at(-1)?.[1].command.action).toBe(A.deleteCargo);
    await updateUser(
      req({ operationId: 'op', expectedVersion: '1:2', usuario: { nome: 'User' } }),
      userCtx,
    );
    expect(m.start.mock.calls.at(-1)?.[1].command.action).toBe(A.updateUser);
  });
  it('reports a busy operation ID and stale-version conflict', async () => {
    m.start.mockRejectedValue(new AccessError(409, 'ACCESS_BUSY', 'Aguarde', 'other'));
    const response = await updateCargo(
      req({ operationId: 'op', expectedVersion: '1:2', cargo: role }),
      ctx,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ operationId: 'other', code: 'ACCESS_BUSY' });
  });
  it('rejects invalid input without starting any operation', async () => {
    expect((await createCargo(req({ operationId: '../bad' }))).status).toBe(400);
    expect(m.start).not.toHaveBeenCalled();
  });
  it('reads server revision and enforces read permission', async () => {
    expect(await (await readCargo(req(), ctx)).json()).toEqual({ value: role, version: '1:2' });
    m.verify.mockResolvedValue({ uid: 'actor', permissions: '0' });
    expect((await readCargo(req(), ctx)).status).toBe(403);
  });
  it('opens legacy display data but rejects invalid authorization in editor reads', async () => {
    m.snapshot.mockResolvedValue({
      exists: true,
      data: () => ({ nome: 'Legacy', permissoes: '1' }),
      updateTime: { seconds: 1, nanoseconds: 2 },
    });
    expect(await (await readCargo(req(), ctx)).json()).toMatchObject({
      value: { nome: 'Legacy', descricao: null, permissoes: '1' },
      version: '1:2',
    });
    m.snapshot.mockResolvedValue({
      exists: true,
      data: () => ({ nome: 'Legacy', email: 'invalid email', ativo: true }),
      updateTime: { seconds: 1, nanoseconds: 2 },
    });
    expect(await (await readUser(req(), userCtx)).json()).toMatchObject({
      value: { email: 'invalid email', ativo: true },
    });
    m.snapshot.mockResolvedValue({ exists: true, data: () => ({ nome: 'Legacy', ativo: 'true' }) });
    expect((await readUser(req(), userCtx)).status).toBe(400);
  });
  it('allows a self-demoted actor to read their operation, but denies unrelated readers', async () => {
    m.verify.mockResolvedValue({ uid: 'actor', permissions: '0' });
    m.get.mockResolvedValue({ id: 'role', actorId: 'actor' });
    expect((await readOperation(req(), ctx)).status).toBe(200);
    m.get.mockResolvedValue({ id: 'role', actorId: 'another' });
    expect((await readOperation(req(), ctx)).status).toBe(403);
  });
  it('passes retry authorization to the coordinator', async () => {
    m.get.mockResolvedValue({ command: { targetId: 'u' } });
    expect((await retryOperation(req(), ctx)).status).toBe(202);
    expect(m.retry.mock.calls[0]?.slice(1)).toEqual([
      'role',
      'actor',
      PERM.configuracoes.read | PERM.configuracoes.write,
    ]);
  });
  it('refreshes through the coordinator with a server version', async () => {
    expect((await refresh(req({ operationId: 'op' }), userCtx)).status).toBe(202);
    expect(m.start.mock.calls[0]?.[1].command).toMatchObject({
      action: A.refreshUser,
      targetId: 'target',
      expectedVersion: '1:2',
    });
    m.snapshot.mockResolvedValue({ exists: false });
    expect((await refresh(req({ operationId: 'op' }), userCtx)).status).toBe(404);
  });
  it('never persists the password in a user command', async () => {
    const response = await createUser(
      req({ operationId: 'op', nome: 'User', email: 'u@example.com', senha: 'secret123' }),
    );
    expect(response.status).toBe(201);
    expect(m.start.mock.calls[0]?.[1].command.usuario).not.toHaveProperty('senha');
    expect(m.provision.mock.calls[0]?.[2]).toBe('secret123');
  });
});
