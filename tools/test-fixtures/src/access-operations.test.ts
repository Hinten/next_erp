import { beforeEach, expect, it, vi } from 'vitest';
import { ACCESS_PHASE as P, SUPERUSER_MASK } from '@delfrance/schemas';
const m = vi.hoisted(() => ({
  createUser: vi.fn(),
  claims: vi.fn(),
  deleteUser: vi.fn(),
  createDoc: vi.fn(),
  deleteDoc: vi.fn(),
  get: vi.fn(),
  active: vi.fn(),
  process: vi.fn(),
}));
vi.mock('firebase-admin/auth', async (original) => ({
  ...(await original<typeof import('firebase-admin/auth')>()),
  getAuth: () => ({
    createUser: m.createUser,
    setCustomUserClaims: m.claims,
    deleteUser: m.deleteUser,
  }),
}));
vi.mock('./admin', () => ({ getApp: () => ({}), db: () => ({}) }));
vi.mock('@delfrance/data/admin/collections', () => ({
  usuarioCollection: { docRef: () => ({ create: m.createDoc, delete: m.deleteDoc }) },
}));
vi.mock('@delfrance/data/admin/cargo-claims', async (original) => ({
  ...(await original<typeof import('@delfrance/data/admin/cargo-claims')>()),
  accessOperations: { docRef: () => ({ delete: m.deleteDoc }) },
  getAccessOperation: m.get,
  getActiveOperationId: m.active,
  processAccessOperation: m.process,
}));
import {
  createAccessTestActor,
  completeAccessTestOperation,
  cleanupAccessTestActor,
  waitForAccessTestTurn,
} from './access-operations';
const actor = () => ({
  uid: 'test-actor',
  email: 'e2e-user-test@example.com',
  operationIds: new Set<string>(),
});
beforeEach(() => {
  vi.resetAllMocks();
  m.createUser.mockResolvedValue({ uid: 'test-actor' });
});
it('seeds the authorization source together with claims for a fresh actor', async () => {
  await createAccessTestActor('e2e-user-test@example.com', 'password');
  expect(m.createDoc).toHaveBeenCalledWith(
    expect.objectContaining({ ativo: true, isSuperUser: true, externalId: null }),
  );
  expect(m.claims).toHaveBeenCalledWith(
    'test-actor',
    expect.objectContaining({ permissions: SUPERUSER_MASK.toString(), su: true }),
  );
});
it('rejects persistent accounts before creating anything', async () => {
  await expect(createAccessTestActor('admin@example.com', 'password')).rejects.toThrow('ephemeral');
  expect(m.createUser).not.toHaveBeenCalled();
});
it('delivers owned work to the real core seam and waits for completion', async () => {
  const fixture = actor();
  m.get
    .mockResolvedValueOnce({ actorId: fixture.uid, phase: P.validating })
    .mockResolvedValue({ actorId: fixture.uid, phase: P.completed });
  await completeAccessTestOperation(fixture, 'op');
  expect(m.process).toHaveBeenCalledTimes(1);
  expect(fixture.operationIds.has('op')).toBe(true);
});
it('never drives another actor operation', async () => {
  m.get.mockResolvedValue({ actorId: 'someone-else', phase: P.validating });
  await expect(completeAccessTestOperation(actor(), 'op')).rejects.toThrow('another actor');
  expect(m.process).not.toHaveBeenCalled();
});
it('reports rejection immediately and does not erase incomplete work during cleanup', async () => {
  const fixture = actor();
  m.get.mockResolvedValue({
    actorId: fixture.uid,
    phase: P.rejected,
    errorCode: 'ACTOR_PERMISSION',
  });
  await expect(completeAccessTestOperation(fixture, 'op')).rejects.toThrow('ACTOR_PERMISSION');
  m.get.mockResolvedValue({ actorId: fixture.uid, phase: P.failed });
  await expect(cleanupAccessTestActor(fixture)).rejects.toThrow('incomplete');
  expect(m.deleteDoc).not.toHaveBeenCalled();
  expect(m.deleteUser).not.toHaveBeenCalled();
});
it('waits for another runner to release the actual reservation without processing its work', async () => {
  m.active.mockResolvedValueOnce('other').mockResolvedValue(null);
  await waitForAccessTestTurn();
  expect(m.active).toHaveBeenCalledTimes(2);
  expect(m.process).not.toHaveBeenCalled();
});
