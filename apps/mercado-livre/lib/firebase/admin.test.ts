import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  firebaseConfigValue,
  resolveProjectId,
  resolveStorageBucketName,
  storageBucketNameOrNull,
} from './admin';

/**
 * The project id must resolve WITHOUT per-backend config on App Hosting /
 * Cloud Run (which inject GOOGLE_CLOUD_PROJECT / FIREBASE_CONFIG for free) —
 * requiring FIREBASE_PROJECT_ID there caused an unhandled 500 on the first
 * deployed rollout. Precedence: explicit env → GOOGLE_CLOUD_PROJECT →
 * FIREBASE_CONFIG.projectId → service-account project_id → null.
 */
describe('resolveProjectId', () => {
  beforeEach(() => {
    vi.stubEnv('FIREBASE_PROJECT_ID', '');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('FIREBASE_CONFIG', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers the explicit FIREBASE_PROJECT_ID', () => {
    vi.stubEnv('FIREBASE_PROJECT_ID', 'explicit-project');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'gcp-project');
    expect(resolveProjectId(null)).toBe('explicit-project');
  });

  it('falls back to GOOGLE_CLOUD_PROJECT (Cloud Run / App Hosting)', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'gcp-project');
    expect(resolveProjectId(null)).toBe('gcp-project');
  });

  it('falls back to FIREBASE_CONFIG.projectId (Firebase-managed runtimes)', () => {
    vi.stubEnv('FIREBASE_CONFIG', JSON.stringify({ projectId: 'config-project' }));
    expect(resolveProjectId(null)).toBe('config-project');
  });

  it('ignores a malformed FIREBASE_CONFIG and keeps falling back', () => {
    vi.stubEnv('FIREBASE_CONFIG', '{not json');
    expect(resolveProjectId({ project_id: 'sa-project' })).toBe('sa-project');
  });

  it('falls back to the service account project_id', () => {
    expect(resolveProjectId({ project_id: 'sa-project' })).toBe('sa-project');
  });

  it('returns null when nothing provides a project id', () => {
    expect(resolveProjectId(null)).toBeNull();
  });
});

/**
 * ⚠️ Every env var the BUCKET ladder can reach, neutralised to '' (falsy).
 *
 * Unlike `resolveProjectId`, which takes the service account as a PARAMETER, the
 * bucket resolvers call `loadServiceAccount()` internally — so they reach three
 * more variables than the block above, and one of them puts `node:fs` on the
 * path: `resolveCredentialPath` THROWS when `FIREBASE_SERVICE_ACCOUNT_PATH`
 * resolves from neither cwd nor repo root.
 *
 * ⚠️ No vitest config in this app loads a `.env` file, so `process.env` in a
 * test IS the developer's ambient shell. A contributor with
 * `FIREBASE_SERVICE_ACCOUNT_PATH=.ignore/service_account.json` exported would red
 * this suite locally while CI stayed green.
 *
 * ⚠️ Stubbing these is what makes `vi.mock('node:fs')` unnecessary: both of
 * `loadServiceAccount`'s guards go falsy, so it returns null without ever calling
 * `existsSync`/`readFileSync`. Do not add the mock — it is module-wide and would
 * MASK a future leak onto that path rather than surface it.
 */
const BUCKET_LADDER_ENV = [
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_CONFIG',
  'FIREBASE_PROJECT_ID',
  'GOOGLE_CLOUD_PROJECT',
  'FIREBASE_SERVICE_ACCOUNT',
  'FIREBASE_SERVICE_ACCOUNT_PATH',
] as const;

/**
 * The bucket ladder: FIREBASE_STORAGE_BUCKET → FIREBASE_CONFIG.storageBucket →
 * `<projectId>.appspot.com`.
 *
 * The middle tier is the fix for a live 500. Firebase changed the DEFAULT bucket
 * for projects created after late 2024 to `<projectId>.firebasestorage.app`, the
 * derived `.appspot.com` does not exist on such a project, and `FIREBASE_CONFIG`
 * on the App Hosting backend was carrying the correct name the whole time.
 *
 * ⚠️ The ORDER is the property under test, not merely that each tier works —
 * every case below pits two tiers against each other with DISAGREEING values, so
 * swapping any pair reds a named test.
 */
describe('resolveStorageBucketName', () => {
  beforeEach(() => {
    for (const name of BUCKET_LADDER_ENV) vi.stubEnv(name, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers FIREBASE_STORAGE_BUCKET over a DISAGREEING FIREBASE_CONFIG', () => {
    vi.stubEnv('FIREBASE_STORAGE_BUCKET', 'override-bucket');
    vi.stubEnv(
      'FIREBASE_CONFIG',
      JSON.stringify({ projectId: 'config-project', storageBucket: 'config-bucket' }),
    );
    expect(resolveStorageBucketName()).toBe('override-bucket');
  });

  it('prefers FIREBASE_CONFIG.storageBucket over the derived .appspot.com', () => {
    // ⚠️ VERBATIM the shape the deployed App Hosting backend injects, empty
    // databaseURL and all. This is the assertion the whole change exists for.
    vi.stubEnv(
      'FIREBASE_CONFIG',
      JSON.stringify({
        databaseURL: '',
        projectId: 'config-project',
        storageBucket: 'config-project.firebasestorage.app',
      }),
    );
    expect(resolveStorageBucketName()).toBe('config-project.firebasestorage.app');
  });

  it('ignores a malformed FIREBASE_CONFIG and derives instead of throwing', () => {
    vi.stubEnv('FIREBASE_CONFIG', '{not json');
    vi.stubEnv('FIREBASE_PROJECT_ID', 'explicit-project');
    expect(resolveStorageBucketName()).toBe('explicit-project.appspot.com');
  });

  it('falls through a FIREBASE_CONFIG carrying no storageBucket', () => {
    vi.stubEnv('FIREBASE_CONFIG', JSON.stringify({ databaseURL: '', projectId: 'config-project' }));
    expect(resolveStorageBucketName()).toBe('config-project.appspot.com');
  });

  it('falls through a FIREBASE_CONFIG whose storageBucket is EMPTY', () => {
    // ⚠️ The blob is KNOWN to carry empty values (`databaseURL: ''` above), so
    // the check is truthiness, never `typeof === 'string'`. Without this case,
    // relaxing it to a type check passes every other assertion in this file.
    vi.stubEnv(
      'FIREBASE_CONFIG',
      JSON.stringify({ databaseURL: '', projectId: 'config-project', storageBucket: '' }),
    );
    expect(resolveStorageBucketName()).toBe('config-project.appspot.com');
  });

  it('derives <projectId>.appspot.com when nothing else is set', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'gcp-project');
    expect(resolveStorageBucketName()).toBe('gcp-project.appspot.com');
  });

  it('throws when nothing resolves a bucket name', () => {
    expect(() => resolveStorageBucketName()).toThrow(/Storage bucket not found/);
  });
});

/**
 * The nullable core `tryGetAdminBucket` rests on.
 *
 * ⚠️ Unreachable through `resolveStorageBucketName`, which turns the null into
 * a throw — so the mass import's skip-photos degradation has no other coverage.
 */
describe('storageBucketNameOrNull', () => {
  beforeEach(() => {
    for (const name of BUCKET_LADDER_ENV) vi.stubEnv(name, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null when nothing resolves a bucket NAME', () => {
    expect(storageBucketNameOrNull()).toBeNull();
  });

  it('takes FIREBASE_CONFIG.storageBucket with no resolvable project id at all', () => {
    // The new tier must not be parasitic on `resolveProjectId`: a config blob
    // carrying a bucket and no projectId still resolves.
    vi.stubEnv('FIREBASE_CONFIG', JSON.stringify({ storageBucket: 'only.firebasestorage.app' }));
    expect(storageBucketNameOrNull()).toBe('only.firebasestorage.app');
  });
});

/**
 * The shared `FIREBASE_CONFIG` reader, tested DIRECTLY.
 *
 * ⚠️ This block is not redundant with the ladder tests above, and mutation
 * testing is what proved it: both public callers guard the result with
 * `if (value)`, so an empty string is swallowed downstream and dropping the
 * helper's own `&& value` reds NOTHING through them. The helper's contract —
 * "null when the variable is absent, unparseable, or carries nothing usable" —
 * is pinned only here, and it is what protects the next caller who forgets to
 * guard.
 */
describe('firebaseConfigValue', () => {
  beforeEach(() => {
    vi.stubEnv('FIREBASE_CONFIG', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads both keys out of the blob the deployed runtime injects', () => {
    // Verbatim the shape observed on the App Hosting backend.
    vi.stubEnv(
      'FIREBASE_CONFIG',
      JSON.stringify({
        databaseURL: '',
        projectId: 'veste-france-debug',
        storageBucket: 'veste-france-debug.firebasestorage.app',
      }),
    );
    expect(firebaseConfigValue('projectId')).toBe('veste-france-debug');
    expect(firebaseConfigValue('storageBucket')).toBe('veste-france-debug.firebasestorage.app');
  });

  it('returns null for an EMPTY value rather than handing back the empty string', () => {
    // ⚠️ The blob demonstrably carries empty values — `databaseURL` is `''` on
    // the real backend. Relaxing the guard to `typeof value === 'string'` passes
    // every other assertion in this file and fails only this one.
    vi.stubEnv('FIREBASE_CONFIG', JSON.stringify({ databaseURL: '', storageBucket: '' }));
    expect(firebaseConfigValue('storageBucket')).toBeNull();
  });

  it('returns null when the variable is absent', () => {
    expect(firebaseConfigValue('projectId')).toBeNull();
  });

  it('returns null when the blob omits the key', () => {
    vi.stubEnv('FIREBASE_CONFIG', JSON.stringify({ projectId: 'only-project' }));
    expect(firebaseConfigValue('storageBucket')).toBeNull();
  });

  it('returns null for a malformed blob rather than throwing', () => {
    vi.stubEnv('FIREBASE_CONFIG', '{not json');
    expect(firebaseConfigValue('projectId')).toBeNull();
  });

  it('rethrows anything that is not a SyntaxError', () => {
    // `JSON.parse('null')` succeeds, then the property read throws a TypeError.
    // The catch is deliberately narrow (root CLAUDE.md rule 6), so this must
    // escape rather than be swallowed as "absent".
    vi.stubEnv('FIREBASE_CONFIG', 'null');
    expect(() => firebaseConfigValue('projectId')).toThrow(TypeError);
  });
});
