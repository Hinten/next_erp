import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type App, type ServiceAccount, cert, getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';

let app: App | undefined;

type RawServiceAccount = ServiceAccount & {
  project_id?: string;
  private_key?: string;
  client_email?: string;
};

function resolveCredentialPath(inputPath: string): string {
  const pathFromCwd = resolve(inputPath);
  if (existsSync(pathFromCwd)) {
    return pathFromCwd;
  }

  // `seed:*` scripts run from `tools/test-fixtures`, while `.env.local` is at
  // the repo root and often uses root-relative paths like `.ignore/...`.
  const pathFromRepoRoot = resolve(process.cwd(), '..', '..', inputPath);
  if (existsSync(pathFromRepoRoot)) {
    return pathFromRepoRoot;
  }

  throw new Error(
    `Service account file not found at "${inputPath}". Tried: "${pathFromCwd}" and "${pathFromRepoRoot}".`,
  );
}

function getServiceAccount(serviceAccountPath?: string): string {
  const explicitPath = serviceAccountPath?.trim();
  if (explicitPath) {
    return readFileSync(resolveCredentialPath(explicitPath), 'utf8');
  }

  const envPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
  if (envPath) {
    return readFileSync(resolveCredentialPath(envPath), 'utf8');
  }

  const envJson = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (envJson) {
    return envJson;
  }

  throw new Error(
    'Provide FIREBASE_SERVICE_ACCOUNT (JSON), FIREBASE_SERVICE_ACCOUNT_PATH, or a service account path argument.',
  );
}

export function getApp(serviceAccountPath?: string): App {
  if (app) return app;
  const sa = getServiceAccount(serviceAccountPath);
  const rawCredentials = JSON.parse(sa) as RawServiceAccount;
  const credentials: ServiceAccount = {
    projectId: rawCredentials.projectId ?? rawCredentials.project_id,
    privateKey: rawCredentials.privateKey ?? rawCredentials.private_key,
    clientEmail: rawCredentials.clientEmail ?? rawCredentials.client_email,
  };
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || credentials.projectId;
  if (!projectId) {
    throw new Error('Project ID not found. Set FIREBASE_PROJECT_ID or provide a service account with project_id.');
  }
  app = getApps()[0] ?? initializeApp({ credential: cert(credentials), projectId });
  return app;
}

/**
 * Firestore handle for the e2e / admin scripts. Targets the database named
 * by `FIREBASE_DATABASE_ID` (default `'default'`). Firestore Enterprise
 * edition uses a database literally named `default` — NOT the free-tier
 * `(default)` that the Admin SDK assumes when no id is passed; omitting the
 * id there yields `5 NOT_FOUND` on every read/write. Mirrors
 * `apps/web`'s `getFirebaseFirestore()` and `apps/integrations`.
 */
export function db(serviceAccountPath?: string): Firestore {
  const databaseId = process.env.FIREBASE_DATABASE_ID?.trim() || 'default';
  return getFirestore(getApp(serviceAccountPath), databaseId);
}

/**
 * Each Playwright run gets its own namespace prefix to avoid collisions when
 * multiple PRs run in parallel against the same staging project.
 */
export function namespace(): string {
  const runId = process.env.GITHUB_RUN_ID ?? 'local';
  return `e2e_${runId}`;
}
