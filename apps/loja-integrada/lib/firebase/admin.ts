import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { type Auth, getAuth } from 'firebase-admin/auth';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';

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
