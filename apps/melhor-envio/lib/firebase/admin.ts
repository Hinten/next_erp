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

export function getAdminApp(): App {
  if (app) return app;
  const existing = getApps()[0];
  if (existing) {
    app = existing;
    return app;
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    throw new Error('FIREBASE_PROJECT_ID is required.');
  }
  // In Firebase App Hosting / Cloud Run, application default credentials are
  // injected automatically. Locally, set FIREBASE_SERVICE_ACCOUNT (inline JSON)
  // or FIREBASE_SERVICE_ACCOUNT_PATH (path to the JSON file).
  const serviceAccount = loadServiceAccount();
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
