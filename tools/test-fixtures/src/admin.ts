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
 * The shard slot of this Playwright process, or `null` when the lane is not
 * sharded. THE single source of truth for that suffix — every run-scoped key
 * derives it from here so the three axes below cannot drift apart.
 *
 * A lane that splits its suite across two jobs of ONE workflow run shares
 * `GITHUB_RUN_ID`, `GITHUB_WORKFLOW` and `GITHUB_REF` with its sibling, and every
 * fixture-isolation key is built from those. Three things break, each its own
 * way, and fixing a subset is worse than fixing none:
 *
 *  1. {@link e2eRunId} keys `e2e_probe/<runId>`, so the sibling's `runTeardown`
 *     deletes the probe this job is still reading — a 404 in its `globalSetup`.
 *  2. `getRunId()` (`apps/web/e2e/_helpers/run-id.ts`) keys `e2ePrefix` and the
 *     ephemeral auth user. Shared, both jobs mint identical `-w<n>-` prefixes
 *     (worker indices restart at 0 per job), and whichever finishes first sweeps
 *     `e2e-<runId>-` and deletes the other's LIVE fixtures — then deletes the
 *     auth user out from under its session.
 *  3. `concurrencyGroupId()` (`apps/web/e2e/_helpers/stale-sweep.ts`) keys the
 *     predecessor marker. Distinct run ids over a SHARED group id is the worst of
 *     the three: the second job reads the first's run id as `previous`, concludes
 *     `cancel-in-progress` superseded it, and sweeps its prefix with
 *     `maxAgeMs: null` — no age gate, mid-run.
 *
 * Unset (the default) reproduces the pre-sharding value byte for byte, so an
 * unsharded lane is untouched.
 *
 * ⚠️ Throws rather than ignoring a malformed value: silently reading
 * `E2E_RUN_SLOT=x` as "unsharded" IS failure mode 2.
 */
export function e2eRunSlot(): string | null {
  const raw = process.env.E2E_RUN_SLOT?.trim();
  if (!raw) return null;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `E2E_RUN_SLOT must be digits only (got ${JSON.stringify(raw)}). It scopes every ` +
        'fixture-isolation key, so a value that parsed as "unsharded" would put two ' +
        "sharded jobs on one key and have them delete each other's live fixtures.",
    );
  }
  return raw;
}

/**
 * The `-s<slot>` segment appended to every run-scoped key; `''` when unsharded.
 *
 * ⚠️ The separator and the trailing dash callers append are load-bearing
 * together: a sweep matches a plain `startsWith` range and the slot is not
 * fixed-width, so `e2e-<id>-s1-` must not prefix `e2e-<id>-s11-`. It does not —
 * the character after `s1` is `-` in one and `1` in the other. Same positional
 * trap as the worker segment in `e2ePrefix` (`w3` ⊂ `w31`), fixed in #1051.
 */
export function e2eRunSlotSuffix(): string {
  const slot = e2eRunSlot();
  return slot ? `-s${slot}` : '';
}

/**
 * Deterministic per-run key, isolating parallel runs against the shared staging
 * project. Carries {@link e2eRunSlotSuffix}, so two shards of one run own
 * separate probes. Stable across re-run attempts by design — GitHub reuses
 * `GITHUB_RUN_ID` and only bumps `GITHUB_RUN_ATTEMPT`, so attempt 2 reclaims
 * attempt 1's doc instead of leaking it.
 */
export function e2eRunId(): string {
  return `${process.env.GITHUB_RUN_ID ?? 'local'}${e2eRunSlotSuffix()}`;
}
