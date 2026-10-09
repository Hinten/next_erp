import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FirebaseError, deleteApp, initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  initializeAuth,
  inMemoryPersistence,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import {
  type Firestore,
  connectFirestoreEmulator,
  deleteDoc,
  getDocFromServer,
  initializeFirestore,
  memoryLocalCache,
  setDoc,
  terminate,
} from 'firebase/firestore';
import { execute } from 'firebase/firestore/pipelines';
import { buildPipeline, defineCollection, PIPELINE_ID_FIELD } from '@delfrance/data';
import { z } from 'zod';

export interface EmulatorAccessConfig {
  projectId: string;
  apiKey: string;
  authHost: string;
  firestoreHost: string;
}

/** Validate before even the Admin fixtures run: a partial emulator setup can route live. */
export function readEmulatorAccessConfig(
  env: NodeJS.ProcessEnv = process.env,
): EmulatorAccessConfig {
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId || !/^demo-[a-z0-9][a-z0-9-]*$/.test(projectId)) {
    throw new Error('[verify-emulator-access] FIREBASE_PROJECT_ID must be a demo- project.');
  }
  if (
    env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== undefined &&
    env.NEXT_PUBLIC_FIREBASE_PROJECT_ID.trim() !== projectId
  ) {
    throw new Error(
      '[verify-emulator-access] NEXT_PUBLIC_FIREBASE_PROJECT_ID must match FIREBASE_PROJECT_ID.',
    );
  }
  if (
    env.FIREBASE_DATABASE_ID?.trim() !== 'default' ||
    (env.NEXT_PUBLIC_FIREBASE_DATABASE_ID !== undefined &&
      env.NEXT_PUBLIC_FIREBASE_DATABASE_ID.trim() !== 'default')
  ) {
    throw new Error(
      '[verify-emulator-access] FIREBASE_DATABASE_ID and NEXT_PUBLIC_FIREBASE_DATABASE_ID ' +
        'must target the literal default database.',
    );
  }
  if (
    env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== undefined &&
    env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== 'true'
  ) {
    throw new Error('[verify-emulator-access] NEXT_PUBLIC_USE_FIREBASE_EMULATOR must be true.');
  }
  // The workflow supplies NEXT_PUBLIC_* during next build. This independent
  // client connects both emulators explicitly and needs no public build env.
  const apiKey = env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim() ?? 'emulator-api-key';
  if (!apiKey) {
    throw new Error('[verify-emulator-access] NEXT_PUBLIC_FIREBASE_API_KEY is required.');
  }

  const publicHost = env.NEXT_PUBLIC_FIREBASE_EMULATOR_HOST?.trim() ?? '127.0.0.1';
  if (!isLoopbackHost(publicHost)) {
    throw new Error(
      '[verify-emulator-access] NEXT_PUBLIC_FIREBASE_EMULATOR_HOST must be loopback.',
    );
  }
  return {
    projectId,
    apiKey,
    authHost: readHost(env, 'FIREBASE_AUTH_EMULATOR_HOST', 9099),
    firestoreHost: readHost(env, 'FIRESTORE_EMULATOR_HOST', 8080),
  };
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost';
}

function readHost(env: NodeJS.ProcessEnv, key: string, port: number): string {
  const value = env[key]?.trim();
  const match = value?.match(/^(127\.0\.0\.1|localhost):([0-9]+)$/);
  if (!match || Number(match[2]) !== port) {
    throw new Error(`[verify-emulator-access] ${key} must be a loopback host on port ${port}.`);
  }
  return match[1]!;
}

const probeCollectionSchema = z.object({
  probeId: z.string(),
  nome: z.string(),
  alternative: z.string(),
  revision: z.number(),
});
const probeCollection = defineCollection({ path: 'e2e_probe', schema: probeCollectionSchema });

/** A denial is useful evidence only when the real client SDK reports permission-denied. */
async function expectPermissionDenied(operation: () => Promise<unknown>, label: string) {
  try {
    await operation();
  } catch (err) {
    if (!(err instanceof FirebaseError) || err.code !== 'permission-denied') throw err;
    return;
  }
  throw new Error(`[verify-emulator-access] anonymous ${label} unexpectedly succeeded.`);
}

/**
 * Exercise the actual client Auth, Core and production pipeline builder against
 * the loaded generated rules. Admin requests would bypass precisely this check.
 */
export async function verifyEmulatorNamespaceAccess(
  email: string,
  password: string,
): Promise<void> {
  const config = readEmulatorAccessConfig();
  const id = `emulator-${randomUUID()}`;
  const clientApp = initializeApp(config, `emulator-preflight-${id}`);
  const anonymousApp = initializeApp(config, `emulator-preflight-anonymous-${id}`);
  let db: Firestore | undefined;
  let anonymousDb: Firestore | undefined;
  let created = false;
  try {
    const auth = initializeAuth(clientApp, { persistence: inMemoryPersistence });
    const anonymousAuth = initializeAuth(anonymousApp, { persistence: inMemoryPersistence });
    connectAuthEmulator(auth, `http://${config.authHost}:9099`, { disableWarnings: true });
    connectAuthEmulator(anonymousAuth, `http://${config.authHost}:9099`, { disableWarnings: true });
    db = initializeFirestore(clientApp, { localCache: memoryLocalCache() }, 'default');
    const anonymousFirestore = initializeFirestore(
      anonymousApp,
      { localCache: memoryLocalCache() },
      'default',
    );
    anonymousDb = anonymousFirestore;
    connectFirestoreEmulator(db, config.firestoreHost, 8080);
    connectFirestoreEmulator(anonymousDb, config.firestoreHost, 8080);
    await signInWithEmailAndPassword(auth, email, password);

    const reference = probeCollection.docRef(db, {}, id);
    const data = { probeId: id, nome: 'Açaí azul', alternative: 'unrelated', revision: 1 };
    await setDoc(reference, data);
    created = true;
    assert.deepEqual((await getDocFromServer(reference)).data(), data);
    await verifyPipeline(db, id, data);

    const updated = { ...data, nome: 'unrelated', alternative: 'AÇAÍ verde', revision: 2 };
    await probeCollection.merge(db, {}, id, updated);
    assert.deepEqual((await getDocFromServer(reference)).data(), updated);
    // Matching only the other field also proves the search combines fields with OR.
    await verifyPipeline(db, id, updated);

    const anonymousReference = probeCollection.docRef(anonymousFirestore, {}, id);
    await expectPermissionDenied(() => getDocFromServer(anonymousReference), 'Core read');
    await expectPermissionDenied(
      () => setDoc(probeCollection.docRef(anonymousFirestore, {}, `${id}-denied`), data),
      'Core create',
    );
    await expectPermissionDenied(
      () => probeCollection.merge(anonymousFirestore, {}, id, { revision: 3 }),
      'Core update',
    );
    await expectPermissionDenied(() => deleteDoc(anonymousReference), 'Core delete');
    await expectPermissionDenied(
      () => execute(buildProbePipeline(anonymousFirestore, id)),
      'Pipeline read',
    );

    await deleteDoc(reference);
    created = false;
    assert.equal((await getDocFromServer(reference)).exists(), false);
  } finally {
    try {
      if (created && db) {
        await Promise.all([
          deleteDoc(probeCollection.docRef(db, {}, id)),
          deleteDoc(probeCollection.docRef(db, {}, `${id}-denied`)),
        ]);
      }
    } finally {
      try {
        await Promise.all(
          [db, anonymousDb].flatMap((instance) => (instance ? [terminate(instance)] : [])),
        );
      } finally {
        await Promise.all([deleteApp(clientApp), deleteApp(anonymousApp)]);
      }
    }
  }
}

function buildProbePipeline(db: Firestore, id: string) {
  return buildPipeline(db, {
    collection: probeCollection.resolvePath({}),
    filters: [{ field: 'probeId', op: 'eq', value: id }],
    search: { term: 'acai', fields: ['nome', 'alternative'] },
    orderBy: [{ field: 'nome', direction: 'asc' }],
    select: ['probeId', 'nome', 'alternative', 'revision'],
    limit: 2,
  });
}

async function verifyPipeline(
  db: Firestore,
  id: string,
  expected: z.infer<typeof probeCollectionSchema>,
) {
  const snapshot = await execute(buildProbePipeline(db, id));
  assert.deepEqual(
    snapshot.results.map((result) => result.data()),
    [{ ...expected, [PIPELINE_ID_FIELD]: id }],
    '[verify-emulator-access] the production pipeline must preserve matching rows and their projected id.',
  );
}
