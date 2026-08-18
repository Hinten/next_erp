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

/**
 * Resolves a service-account path that may be root-relative (e.g.
 * `.ignore/service_account.json` from `.env.local`) while the script cwd is
 * `tools/test-fixtures`. Tries cwd first, then two levels up (repo root).
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

  // Emulator mode: `firebase emulators:exec` exports FIRESTORE_EMULATOR_HOST /
  // FIREBASE_AUTH_EMULATOR_HOST, and the Admin SDK auto-routes to the emulators
  // and ignores real credentials — so skip the service-account requirement and
  // init a bare app with the (demo) project id. Used by the estoque emulator e2e
  // lane (.github/workflows/e2e-emulator.yml); the staging path below is unchanged.
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    const emulatorProjectId = process.env.FIREBASE_PROJECT_ID?.trim() || 'demo-erp';
    app = getApps()[0] ?? initializeApp({ projectId: emulatorProjectId });
    return app;
  }

  const sa = getServiceAccount(serviceAccountPath);
  const rawCredentials = JSON.parse(sa) as RawServiceAccount;
  const credentials: ServiceAccount = {
    projectId: rawCredentials.projectId ?? rawCredentials.project_id,
    privateKey: rawCredentials.privateKey ?? rawCredentials.private_key,
    clientEmail: rawCredentials.clientEmail ?? rawCredentials.client_email,
  };
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || credentials.projectId;
  if (!projectId) {
    throw new Error(
      'Project ID not found. Set FIREBASE_PROJECT_ID or provide a service account with project_id.',
    );
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
 * The rules probe collection: a FIXED name, with the run id as the DOCUMENT id.
 *
 * The run id used to live in the collection *name* (`e2e_<runId>_probe`), which
 * meant every run minted a new collection and reclaiming another run's leftovers
 * needed a root `listCollections()` — a cost that grows with the leak itself.
 * With the id in the key, teardown is a keyed `delete()`: O(1), no enumeration.
 *
 * Still matches the staging-only rule regex `^e2e_[0-9A-Za-z_]+$`
 * (`firestore.e2e.rules`), so nothing about the ruleset changes.
 */
export const E2E_PROBE_COLLECTION = 'e2e_probe';

/**
 * Deterministic per-run key, isolating parallel runs against the shared staging
 * project. Stable across re-run attempts by design — GitHub reuses
 * `GITHUB_RUN_ID` and only bumps `GITHUB_RUN_ATTEMPT`, so attempt 2 reclaims
 * attempt 1's doc instead of leaking it.
 */
export function e2eRunId(): string {
  return process.env.GITHUB_RUN_ID ?? 'local';
}
