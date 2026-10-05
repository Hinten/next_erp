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
 * Resolve the Firebase project id without demanding per-backend config.
 * Order: explicit `FIREBASE_PROJECT_ID` (dev / override) → `GOOGLE_CLOUD_PROJECT`
 * → `FIREBASE_CONFIG.projectId` → the service-account JSON's own `project_id`.
 * Exported for unit tests.
 *
 * ⚠️ **Only `FIREBASE_CONFIG` is actually injected on a deployed backend.** This
 * comment used to say Cloud Run / App Hosting supply `GOOGLE_CLOUD_PROJECT` "for
 * free"; they do not. The Cloud Run container contract sets only PORT /
 * K_SERVICE / K_REVISION / K_CONFIGURATION, and the project id lives on the
 * METADATA SERVER, never in an env var. Verified against the deployed service:
 * neither `GOOGLE_CLOUD_PROJECT` nor `FIREBASE_PROJECT_ID` is present there.
 *
 * That false premise is not academic — it is why `packages/ai` stopped its own
 * ladder one tier short and threw on every AI call in staging. These files only
 * escaped because they already had the `FIREBASE_CONFIG` tier below.
 */
export function resolveProjectId(serviceAccount: Record<string, unknown> | null): string | null {
  const explicit = process.env.FIREBASE_PROJECT_ID;
  if (explicit) return explicit;

  // ⚠️ NOT set by Cloud Run / App Hosting — see the note above. Kept as a tier
  // because some GCP tooling and local shells do export it, never because the
  // platform does.
  const gcp = process.env.GOOGLE_CLOUD_PROJECT;
  if (gcp) return gcp;

  // Firebase-managed runtimes (App Hosting, Functions) inject FIREBASE_CONFIG
  // as a JSON string carrying the projectId.
  const firebaseConfig = process.env.FIREBASE_CONFIG;
  if (firebaseConfig) {
    try {
      const parsed = JSON.parse(firebaseConfig) as { projectId?: unknown };
      if (typeof parsed.projectId === 'string' && parsed.projectId) return parsed.projectId;
    } catch (err) {
      // Malformed FIREBASE_CONFIG — treat as absent and keep falling back.
      if (!(err instanceof SyntaxError)) throw err;
    }
  }

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
      'Firebase project id not found. Tried FIREBASE_PROJECT_ID, GOOGLE_CLOUD_PROJECT, ' +
        'FIREBASE_CONFIG.projectId and the service account. On a deployed backend ' +
        'FIREBASE_CONFIG is the one that answers — Cloud Run exposes the project only ' +
        'via the metadata server, never as an env var, so GOOGLE_CLOUD_PROJECT being ' +
        'unset there is normal. In local dev set FIREBASE_PROJECT_ID or provide a ' +
        'service account.',
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

/* -------------------------------------------------------------------------- */
/*  Cloud Storage — added by step 9 (#1517), the product photo import.         */
/*                                                                            */
/*  ⚠️ The four functions below are copied VERBATIM from the shipped           */
/*  `apps/mercado-livre/lib/firebase/admin.ts`, warnings included: the bucket   */
/*  ladder is the fix for a live 500 and its middle tier is the whole reason it */
/*  exists. Nothing above this banner changed — `resolveProjectId` keeps its    */
/*  own inline `FIREBASE_CONFIG` parse rather than being refactored onto        */
/*  `firebaseConfigValue`, so this file stays byte-identical to the copy the    */
/*  six sibling channel apps carry except for the storage block.               */
/* -------------------------------------------------------------------------- */

/**
 * The shared `FIREBASE_CONFIG` reader (ML's, verbatim): null when the variable
 * is absent, unparseable, or carries nothing usable.
 *
 * ⚠️ `&& value` and not `typeof value === 'string'`: the blob the deployed
 * runtime injects demonstrably carries EMPTY values (`databaseURL: ''`), and a
 * caller that forgets to guard would then get `''` where it expected a name.
 * Exported for unit tests — both callers guard the result, so the helper's own
 * contract is pinned only there.
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
      'Storage bucket not found. Tried FIREBASE_STORAGE_BUCKET, ' +
        'FIREBASE_CONFIG.storageBucket, then deriving it from the project id. On a ' +
        'deployed backend FIREBASE_CONFIG carries the real bucket. ⚠️ Do not reach ' +
        'for the derived <projectId>.appspot.com name: a project created after late ' +
        '2024 defaults to <projectId>.firebasestorage.app, so that bucket does not ' +
        'exist and uploads 404. Set FIREBASE_STORAGE_BUCKET to the real bucket name.',
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

/** The default Cloud Storage bucket for server-side uploads (the photo import). */
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
