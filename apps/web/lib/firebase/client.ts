import { type FirebaseApp, getApps, initializeApp } from 'firebase/app';
import {
  type Auth,
  browserLocalPersistence,
  connectAuthEmulator,
  initializeAuth,
  indexedDBLocalPersistence,
} from 'firebase/auth';
import {
  type Firestore,
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import { type Functions, connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { type FirebaseStorage, getStorage } from 'firebase/storage';

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Emulator wiring — build-time flag (`NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true`,
// inlined by `next build`) points Auth / Firestore / Functions at a local Firebase
// Emulator Suite. Used by the emulator-backed e2e job (`.github/workflows/e2e-emulator.yml`)
// so the `aplicarEstoque` callable runs locally instead of needing a staging deploy.
// Ports mirror `firebase.functions.json`; unset → the normal production path, so the
// staging e2e and the real app are unaffected.
const USE_FIREBASE_EMULATOR = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === 'true';

/**
 * True when this build talks to the emulator suite.
 *
 * ⚠️ Needed as a CAPABILITY gate, not just for wiring: the emulator is a
 * Standard-edition Firestore and rejects the Pipelines API, while the SDK still
 * exposes `db.pipeline()` — so `isPipelineSupported(db)` answers *yes* and the
 * call fails at execution time. Any code with a pipeline path plus a classic
 * fallback must branch on THIS, not on the SDK probe.
 */
export function isUsingFirebaseEmulator(): boolean {
  return USE_FIREBASE_EMULATOR;
}
const EMULATOR_HOST = process.env.NEXT_PUBLIC_FIREBASE_EMULATOR_HOST ?? '127.0.0.1';

let app: FirebaseApp | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;
let storage: FirebaseStorage | undefined;
let functions: Functions | undefined;

export function getFirebaseApp(): FirebaseApp {
  if (app) return app;
  app = getApps()[0] ?? initializeApp(config);
  return app;
}

export function getFirebaseAuth(): Auth {
  if (auth) return auth;
  // initializeAuth (vs getAuth) lets us pick persistence explicitly.
  // indexedDB survives across tabs; falls back to localStorage in private mode.
  auth = initializeAuth(getFirebaseApp(), {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  });
  if (USE_FIREBASE_EMULATOR) {
    connectAuthEmulator(auth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
  }
  return auth;
}

export function getFirebaseFirestore(): Firestore {
  if (db) return db;
  const databaseId = process.env.NEXT_PUBLIC_FIREBASE_DATABASE_ID ?? 'default';
  // `initializeFirestore` (vs `getFirestore`) lets us enable the IndexedDB
  // persistent cache with multi-tab coordination: the inbox streams the same
  // conversas/messages across the app, so a warm local cache makes navigation
  // instant and cuts reads. This is the ONLY caller (the module-level `db`
  // singleton guards against a second init on the same app+database), and the
  // 3rd positional arg pins the named database (`default`, not `(default)`).
  db = initializeFirestore(
    getFirebaseApp(),
    { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) },
    databaseId,
  );
  if (USE_FIREBASE_EMULATOR) {
    connectFirestoreEmulator(db, EMULATOR_HOST, 8080);
  }
  return db;
}

export function getFirebaseFunctions(): Functions {
  if (functions) return functions;
  // Region MUST match the Cloud Functions deploy region — which must itself match
  // the Storage bucket's, or the gen2 triggers never fire. Kept in an env var so
  // client and functions stay in sync, with NO default: a callable invoked against
  // the wrong region fails as an opaque `internal`/CORS error rather than
  // anything that names the real problem, so a missing value must stop here.
  //
  // ⚠️ Thrown from this lazy accessor, never at module scope: NEXT_PUBLIC_* is
  // inlined at build time, so a module-scope check would take the whole app down
  // at boot over a feature most screens never touch. Here it fails only when a
  // callable is actually used, and says why.
  const region = process.env.NEXT_PUBLIC_FUNCTIONS_REGION?.trim();
  if (!region) {
    throw new Error(
      'NEXT_PUBLIC_FUNCTIONS_REGION is not set, so callables have no region to ' +
        'target. It is inlined at BUILD time, so setting it now is not enough — ' +
        'set it and rebuild. It must equal the region apps/functions was deployed ' +
        'to (FUNCTIONS_REGION).',
    );
  }
  functions = getFunctions(getFirebaseApp(), region);
  if (USE_FIREBASE_EMULATOR) {
    connectFunctionsEmulator(functions, EMULATOR_HOST, 5001);
  }
  return functions;
}

export function getFirebaseStorage(): FirebaseStorage {
  if (storage) return storage;
  storage = getStorage(getFirebaseApp());
  // Bound the SDK's internal retry window so a blocked/failed upload (e.g. a
  // bucket CORS misconfiguration) surfaces a real FirebaseError in ~30s instead
  // of retrying silently for the ~120s default — which looks like a hung UI.
  storage.maxUploadRetryTime = 30_000;
  return storage;
}
