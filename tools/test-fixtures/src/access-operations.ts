import { setTimeout as delay } from 'node:timers/promises';
import { FirebaseAuthError, getAuth } from 'firebase-admin/auth';
import { rulesClaimsFromBits } from '@delfrance/auth';
import { ACCESS_PHASE as P, SUPERUSER_MASK, usuarioSchema } from '@delfrance/schemas';
import { usuarioCollection } from '@delfrance/data/admin/collections';
import {
  accessOperations,
  getAccessOperation,
  getActiveOperationId,
  processAccessOperation,
  withAccessAuth,
} from '@delfrance/data/admin/cargo-claims';
import { db, getApp } from './admin';

export interface AccessTestActor {
  uid: string;
  email: string;
  operationIds: Set<string>;
}

/** A fresh actor per worker: both Auth and the authorization source must exist.
 * Never change the persistent SU account or another run's authorization data. */
export async function createAccessTestActor(
  email: string,
  password: string,
): Promise<AccessTestActor> {
  if (!email.startsWith('e2e-user-'))
    throw new Error('Access fixture requires an ephemeral e2e-user email.');
  const auth = getAuth(getApp());
  const user = await auth.createUser({
    email,
    password,
    emailVerified: true,
    displayName: 'E2E access actor',
  });
  await usuarioCollection.docRef(db(), {}, user.uid).create(
    usuarioSchema.parse({
      nome: 'E2E access actor',
      email,
      ativo: true,
      isSuperUser: true,
    }),
  );
  await auth.setCustomUserClaims(user.uid, {
    permissions: SUPERUSER_MASK.toString(),
    su: true,
    ...rulesClaimsFromBits(SUPERUSER_MASK),
  });
  return { uid: user.uid, email, operationIds: new Set() };
}

/** The test runner supplies task delivery, using the actual coordinator, Auth
 * and Firestore. No HTTP handler or production scheduling code has a test mode.
 * Only this actor's accepted operations may be driven; another runner's global
 * reservation must finish in that runner (the UI receives a real 409 meanwhile).
 */
export async function completeAccessTestOperation(actor: AccessTestActor, id: string) {
  const database = db();
  const auth = withAccessAuth(getAuth(getApp()), FirebaseAuthError);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const op = await getAccessOperation(database, id);
    if (op.actorId !== actor.uid)
      throw new Error("Refusing to drive another actor's access operation.");
    actor.operationIds.add(id);
    if (op.phase === P.completed) return op;
    if (op.phase === P.failed || op.phase === P.rejected)
      throw new Error(`Access operation ${id}: ${op.phase} (${op.errorCode}): ${op.errorMessage}`);
    await processAccessOperation(database, auth, id);
    await delay(100);
  }
  throw new Error(`Access operation ${id} did not finish within the fixture deadline.`);
}

/** Push and pull_request lanes run concurrently against staging. Retry only
 * their explicit reservation conflict, never a rejected authorization command. */
export async function waitForAccessTestTurn() {
  const deadline = Date.now() + 90_000;
  while (await getActiveOperationId(db())) {
    if (Date.now() >= deadline)
      throw new Error('Another access operation retained the global reservation.');
    await delay(500);
  }
}

export async function cleanupAccessTestActor(actor: AccessTestActor) {
  // Keep an incomplete operation and its actor intact for diagnosis/recovery.
  for (const id of actor.operationIds) {
    const op = await getAccessOperation(db(), id);
    if (op.actorId !== actor.uid || (op.phase !== P.completed && op.phase !== P.rejected))
      throw new Error(`Refusing to discard incomplete access operation ${id}.`);
    await accessOperations.docRef(db(), {}, id).delete();
  }
  await usuarioCollection.docRef(db(), {}, actor.uid).delete();
  await getAuth(getApp()).deleteUser(actor.uid);
}
