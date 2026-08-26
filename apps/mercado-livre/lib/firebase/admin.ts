import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { type Auth, getAuth } from 'firebase-admin/auth';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { type Storage, getStorage } from 'firebase-admin/storage';

let app: App | undefined;

// Mirrors `tools/test-fixtures/src/admin.ts:resolveCredentialPath`: the path
// from `.env.local` is conventionally repo-root-relative (e.g.
// `.ignore/service_account.json`), but each Next app's cwd is its own dir.
// Try cwd first (works for absolute paths and same-dir relatives), then walk
// two levels up to the repo / worktree root.
function resolveCredentialPath(inputPath: string): string {
  const fromCwd = resolve(inputPath);
  if (existsSync(fromCwd)) return fromCwd;

  const fromRoot = resolve(process.cwd(), '..', '..', inputPath);
  if (existsSync(fromRoot)) return fromRoot;

  throw new Error(
    `Service account file not found at "${inputPath}". Tried: "${fromCwd}" and "${fromRoot}".`,
  );
}

function loadServiceAccount(): Record<string, unknown> | null {
  // Two ways to provide credentials in dev — pick whichever is set:
  // - FIREBASE_SERVICE_ACCOUNT: the full JSON inline (used in deploy, where
  //   Secret Manager stores it as a single-line string).
  // - FIREBASE_SERVICE_ACCOUNT_PATH: filesystem path to the JSON (much easier
  //   in dev — no escaping the `\n` in `private_key`). Path resolution falls
  //   back to repo root so `.env.local`'s convention (e.g.
  //   `.ignore/service_account.json`) Just Works from any app's cwd.
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline) return JSON.parse(inline);

  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (path) return JSON.parse(readFileSync(resolveCredentialPath(path), 'utf-8'));

  return null;
}

/**
 * A STRING field out of `FIREBASE_CONFIG`, the JSON blob Firebase-managed
 * runtimes (App Hosting, Cloud Functions) inject — `null` when the variable is
 * absent, unparseable, or carries nothing usable for `key`.
 *
 * ⚠️ TRUTHINESS, not `typeof === 'string'`. The blob really does carry EMPTY
 * values: the deployed App Hosting backend's is exactly
 * `{"databaseURL":"","projectId":"…","storageBucket":"…"}`, so a type-only check
 * would hand a caller `''` and stop the ladder on a value that resolves nothing.
 *
 * ⚠️ firebase-admin ALSO accepts a filesystem PATH in this variable
 * (`lib/app/lifecycle.js:loadOptionsFromEnvVar` —
 * `config.startsWith('{') ? config : readFileSync(config)`). That form is
 * deliberately NOT supported here: no runtime this repo deploys to uses it, and
 * reading the filesystem out of a config resolver would make every unit test
 * that touches it non-hermetic. A path lands in the `SyntaxError` catch below,
 * so the caller keeps falling back — the same outcome as an absent value.
 *
 * ⚠️ Exported for unit tests, and that is load-bearing rather than tidy. BOTH
 * current callers guard the result with `if (value)` before using it, so an
 * empty string is swallowed downstream and the `&& value` below is invisible to
 * every ladder test — mutation-proven: deleting it reds nothing through the
 * public functions. Testing the contract HERE is the only thing pinning it, and
 * the contract is what protects the next caller who forgets to guard.
 */
export function firebaseConfigValue(key: 'projectId' | 'storageBucket'): string | null {
  const raw = process.env.FIREBASE_CONFIG;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === 'string' && value ? value : null;
  } catch (err) {
    // Malformed FIREBASE_CONFIG — treat as absent and keep falling back.
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
}

/**
 * Resolve the Firebase project id without demanding per-backend config.
 * Order: explicit `FIREBASE_PROJECT_ID` (dev / override) → the env Cloud Run /
 * App Hosting inject for free (`GOOGLE_CLOUD_PROJECT`, `FIREBASE_CONFIG`) → the
 * service-account JSON's own `project_id`. Exported for unit tests.
 */
export function resolveProjectId(serviceAccount: Record<string, unknown> | null): string | null {
  const explicit = process.env.FIREBASE_PROJECT_ID;
  if (explicit) return explicit;

  // Cloud Run (and therefore Firebase App Hosting) sets this on every service.
  const gcp = process.env.GOOGLE_CLOUD_PROJECT;
  if (gcp) return gcp;

  // Firebase-managed runtimes (App Hosting, Functions) inject FIREBASE_CONFIG
  // as a JSON string carrying the projectId.
  const fromConfig = firebaseConfigValue('projectId');
  if (fromConfig) return fromConfig;

  const saProject = serviceAccount?.project_id;
  if (typeof saProject === 'string' && saProject) return saProject;

  return null;
}

export function getAdminApp(): App {
  if (app) return app;
  const existing = getApps()[0];
  if (existing) {
    app = existing;
    return app;
  }
  const serviceAccount = loadServiceAccount();
  const projectId = resolveProjectId(serviceAccount);
  if (!projectId) {
    throw new Error(
      'Firebase project id not found. Set FIREBASE_PROJECT_ID (or provide a service ' +
        'account) in local dev; on App Hosting / Cloud Run it is auto-detected via ' +
        'GOOGLE_CLOUD_PROJECT / FIREBASE_CONFIG.',
    );
  }
  // In Firebase App Hosting / Cloud Run, application default credentials are
  // injected automatically. Locally, set FIREBASE_SERVICE_ACCOUNT (inline JSON)
  // or FIREBASE_SERVICE_ACCOUNT_PATH (path to the JSON file).
  app = serviceAccount
    ? initializeApp({ credential: cert(serviceAccount), projectId })
    : initializeApp({ projectId });
  return app;
}

export function getAdminAuth(): Auth {
  return getAuth(getAdminApp());
}

export function getAdminFirestore(): Firestore {
  const databaseId = process.env.FIREBASE_DATABASE_ID ?? 'default';
  return getFirestore(getAdminApp(), databaseId);
}

/**
 * Resolve the Cloud Storage bucket name.
 *
 * `getAdminApp()` passes an explicit options object to `initializeApp`, and
 * firebase-admin merges `FIREBASE_CONFIG` into the app ONLY on the no-argument
 * path (`lib/app/lifecycle.js`: `if (typeof options === 'undefined') { options =
 * loadOptionsFromEnvVar() }`). So this app's admin app carries no
 * `storageBucket`, a no-arg `.bucket()` would throw, and the name has to be
 * resolved here.
 *
 * Order: `FIREBASE_STORAGE_BUCKET` (operator override) →
 * `FIREBASE_CONFIG.storageBucket` (the runtime's OWN answer, injected on App
 * Hosting / Cloud Functions) → the classic `<projectId>.appspot.com`.
 *
 * ⚠️ The middle tier is not a nicety. Firebase changed the DEFAULT bucket for
 * projects created after late 2024 to `<projectId>.firebasestorage.app`, so on
 * this project the derived `.appspot.com` names a bucket that DOES NOT EXIST —
 * an unhandled 500 on the first server-side upload, which is how it was found:
 * live, on the ML product import. `FIREBASE_CONFIG` carried the correct name the
 * whole time and nothing read it.
 *
 * ⚠️ Only the deployed runtimes inject `FIREBASE_CONFIG`, so local dev is
 * unchanged: the tier is inert there and the derivation still runs.
 *
 * Exported for unit tests.
 */
export function resolveStorageBucketName(): string {
  const name = storageBucketNameOrNull();
  if (!name) {
    throw new Error(
      'Storage bucket not found. Set FIREBASE_STORAGE_BUCKET (or FIREBASE_PROJECT_ID / ' +
        'a service account so it can be derived as <projectId>.appspot.com).',
    );
  }
  return name;
}

/**
 * The nullable core of `resolveStorageBucketName` — null when unresolvable.
 *
 * ⚠️ Exported for unit tests: the null branch is UNREACHABLE through
 * `resolveStorageBucketName`, which converts it into a throw, so nothing else can
 * cover the contract `tryGetAdminBucket` rests on.
 */
export function storageBucketNameOrNull(): string | null {
  const explicit = process.env.FIREBASE_STORAGE_BUCKET;
  if (explicit) return explicit;

  const fromConfig = firebaseConfigValue('storageBucket');
  if (fromConfig) return fromConfig;

  const projectId = resolveProjectId(loadServiceAccount());
  return projectId ? `${projectId}.appspot.com` : null;
}

/** The default Cloud Storage bucket for server-side uploads (ML photo import). */
export function getAdminBucket(): ReturnType<Storage['bucket']> {
  return getStorage(getAdminApp()).bucket(resolveStorageBucketName());
}

/**
 * Like `getAdminBucket`, but null when the bucket NAME can't be resolved
 * (missing FIREBASE_STORAGE_BUCKET / derivable project id) — for callers that
 * deliberately degrade to skip-photos (the mass-import job) instead of failing.
 * Real infra bugs (a broken admin app, Storage SDK failures) still throw.
 */
export function tryGetAdminBucket(): ReturnType<Storage['bucket']> | null {
  const name = storageBucketNameOrNull();
  return name ? getStorage(getAdminApp()).bucket(name) : null;
}
