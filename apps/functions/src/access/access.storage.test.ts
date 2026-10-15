import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { AuthErrorCode, FirebaseAuthError, type Auth } from 'firebase-admin/auth';
import { expect, it, vi } from 'vitest';
import {
  ACCESS_ACTION as A,
  ACCESS_PHASE as P,
  SUPERUSER_MASK,
  cargoSchema,
  usuarioSchema,
} from '@delfrance/schemas';
import {
  startAccessOperation,
  processAccessOperation,
  getAccessOperation,
  snapshotVersion,
  withAccessAuth,
} from '@delfrance/data/admin/cargo-claims';

// Real Firestore transactions/query pagination; Auth and task transport remain
// seams because the storage lane has no Cloud Tasks emulator.
it('commits after validation and propagates using real Firestore transactions', async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST)
    throw new Error('Run under firebase.functions.json emulators only.');
  const app = initializeApp({ projectId: 'demo-erp' }, 'access-' + randomUUID());
  const db = getFirestore(app, 'default');
  const id = 'access-' + randomUUID();
  const actorId = id + '-actor';
  const uid = id + '-holder';
  const cargoId = id + '-cargo';
  const account = { uid, disabled: false, customClaims: {} };
  const write = vi.fn(async (_uid: string, claims: object) => {
    account.customClaims = claims;
  });
  const auth = {
    getUsers: async () => ({ users: [account] }),
    setCustomUserClaims: write,
    getUser: async (target: string) => {
      if (target === actorId) return { uid: actorId, disabled: false };
      if (target === uid) return account;
      throw new FirebaseAuthError({ code: AuthErrorCode.USER_NOT_FOUND, message: 'missing' });
    },
  } as unknown as Auth;
  const cargo = cargoSchema.parse({ nome: id, descricao: null, permissoes: '1' });
  const paths = [
    'cargos/' + cargoId,
    'usuarios/' + uid,
    'usuarios/' + actorId,
    'accessOperations/' + id,
    'accessOperations/' + id + '-other',
  ];
  try {
    await db.doc(paths[0]!).set(cargo);
    await db
      .doc(paths[1]!)
      .set(usuarioSchema.parse({ nome: id, colaborador: true, cargos: [cargoId] }));
    await db.doc(paths[2]!).set(usuarioSchema.parse({ nome: id, isSuperUser: true }));
    const version = snapshotVersion(await db.doc(paths[0]!).get());
    const command = {
      id,
      actorId,
      tokenBits: SUPERUSER_MASK,
      command: {
        action: A.updateCargo,
        targetId: cargoId,
        expectedVersion: version,
        cargo: { ...cargo, permissoes: '3' },
        usuario: null,
      },
    };
    const admissions = await Promise.allSettled([
      startAccessOperation(db, command),
      startAccessOperation(db, { ...command, id: id + '-other' }),
    ]);
    expect(admissions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = admissions.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
      code: 'ACCESS_BUSY',
    });
    const accepted = admissions.find((result) => result.status === 'fulfilled');
    const operationId = accepted?.status === 'fulfilled' ? accepted.value.id : '';
    await processAccessOperation(db, withAccessAuth(auth, FirebaseAuthError), operationId);
    expect((await db.doc(paths[0]!).get()).data()?.permissoes).toBe('1');
    expect(write).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i++)
      await processAccessOperation(db, withAccessAuth(auth, FirebaseAuthError), operationId);
    expect((await getAccessOperation(db, operationId)).phase).toBe(P.completed);
    expect(account.customClaims).toMatchObject({ permissions: '3', d_cliente: 3 });
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    await Promise.all(paths.map((path) => db.doc(path).delete()));
    const control = db.doc('accessControl/current');
    const state = await control.get();
    if ([id, id + '-other'].includes(state.data()?.lastId)) await control.delete();
    await db.terminate();
    await deleteApp(app);
  }
});
