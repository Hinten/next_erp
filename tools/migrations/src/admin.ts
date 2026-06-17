import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type App, type ServiceAccount, cert, getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';

type RawServiceAccount = ServiceAccount & {
  project_id?: string;
  private_key?: string;
  client_email?: string;
};

/**
 * Resolve a service-account path that may be root-relative (e.g.
 * `.ignore/service_account.json` from `.env.local`) while the script cwd is
 * `tools/migrations`. Tries cwd first, then two levels up (repo root). Mirrors
 * `tools/test-fixtures/src/admin.ts`.
 */
function resolveCredentialPath(inputPath: string): string {
  const fromCwd = resolve(inputPath);
  if (existsSync(fromCwd)) return fromCwd;
  const fromRoot = resolve(process.cwd(), '..', '..', inputPath);
  if (existsSync(fromRoot)) return fromRoot;
  throw new Error(
    `Service account file not found at "${inputPath}". Tried: "${fromCwd}" and "${fromRoot}".`,
  );
}

function loadServiceAccount(serviceAccountPath?: string): ServiceAccount {
  const explicit = serviceAccountPath?.trim();
  const envPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
  const envJson = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();

  let raw: string;
  if (explicit) raw = readFileSync(resolveCredentialPath(explicit), 'utf8');
  else if (envPath) raw = readFileSync(resolveCredentialPath(envPath), 'utf8');
  else if (envJson) raw = envJson;
  else
    throw new Error(
      'Provide FIREBASE_SERVICE_ACCOUNT (JSON), FIREBASE_SERVICE_ACCOUNT_PATH, or --service-account.',
    );

  const parsed = JSON.parse(raw) as RawServiceAccount;
  return {
    projectId: parsed.projectId ?? parsed.project_id,
    privateKey: parsed.privateKey ?? parsed.private_key,
    clientEmail: parsed.clientEmail ?? parsed.client_email,
  };
}

/**
 * Firestore handle for a migration, bound to an **explicit** project. The
 * project is never inferred from the environment — a migration refuses to run
 * without `--project`, so a stray `FIREBASE_PROJECT_ID` can never silently
 * point a destructive backfill at production. If the supplied service account
 * names a different project than `--project`, we refuse rather than risk
 * writing to the wrong database. Targets the database named by
 * `FIREBASE_DATABASE_ID` (default `'default'`), matching the rest of the repo.
 */
export function migrationDb(projectId: string, serviceAccountPath?: string): Firestore {
  const credentials = loadServiceAccount(serviceAccountPath);
  if (credentials.projectId && credentials.projectId !== projectId) {
    throw new Error(
      `Service account project "${credentials.projectId}" does not match --project "${projectId}". ` +
        'Refusing to run against a project the credentials were not issued for.',
    );
  }
  const app: App =
    getApps()[0] ?? initializeApp({ credential: cert(credentials), projectId }, 'migrations');
  const databaseId = process.env.FIREBASE_DATABASE_ID?.trim() || 'default';
  return getFirestore(app, databaseId);
}
