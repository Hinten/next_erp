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
 * Resolve the Cloud Storage bucket name. `getAdminApp()` does NOT set
 * `storageBucket`, so a no-arg `.bucket()` would throw — resolve it explicitly:
 * `FIREBASE_STORAGE_BUCKET` (set it on the backend if the derived name is wrong,
 * e.g. a newer `<project>.firebasestorage.app` bucket), else the classic default
 * `<projectId>.appspot.com`. Exported for unit tests.
 */
export function resolveStorageBucketName(): string {
  const explicit = process.env.FIREBASE_STORAGE_BUCKET;
  if (explicit) return explicit;
  const projectId = resolveProjectId(loadServiceAccount());
  if (!projectId) {
    throw new Error(
      'Storage bucket not found. Set FIREBASE_STORAGE_BUCKET (or FIREBASE_PROJECT_ID / ' +
        'a service account so it can be derived as <projectId>.appspot.com).',
    );
  }
  return `${projectId}.appspot.com`;
}

/** The default Cloud Storage bucket for server-side uploads (ML photo import). */
export function getAdminBucket(): ReturnType<Storage['bucket']> {
  return getStorage(getAdminApp()).bucket(resolveStorageBucketName());
}
