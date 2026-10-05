import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  firebaseConfigValue,
  resolveStorageBucketName,
  storageBucketNameOrNull,
  tryGetAdminBucket,
} from './admin';

/**
 * The Cloud Storage half of this app's admin singleton, added by step 9 (#1517)
 * for the product photo import and copied verbatim from Mercado Livre's.
 *
 * ⚠️ Every env var the BUCKET ladder can reach is neutralised to `''` (falsy).
 * The bucket resolvers call `loadServiceAccount()` internally, so they reach
 * three more variables than the name ladder suggests — and one of them puts
 * `node:fs` on the path: `resolveCredentialPath` THROWS when
 * `FIREBASE_SERVICE_ACCOUNT_PATH` resolves from neither cwd nor repo root.
 *
 * ⚠️ No vitest config in this app loads a `.env` file, so `process.env` in a
 * test IS the developer's ambient shell. A contributor with
 * `FIREBASE_SERVICE_ACCOUNT_PATH=.ignore/service_account.json` exported would
 * red this suite locally while CI stayed green.
 *
 * ⚠️ Stubbing these is what makes `vi.mock('node:fs')` unnecessary: both of
 * `loadServiceAccount`'s guards go falsy, so it returns null without ever
 * calling `existsSync`/`readFileSync`. Do not add the mock — it is module-wide
 * and would MASK a future leak onto that path rather than surface it.
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
 * The ladder: FIREBASE_STORAGE_BUCKET → FIREBASE_CONFIG.storageBucket →
 * `<projectId>.appspot.com`.
 *
 * The middle tier is the fix for a live 500: Firebase changed the DEFAULT bucket
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
    // ⚠️ VERBATIM the shape a deployed App Hosting backend injects, empty
    // databaseURL and all. This is the assertion the whole tier exists for.
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
 * ⚠️ Unreachable through `resolveStorageBucketName`, which turns the null into a
 * throw — so the mass import's skip-photos degradation has no other coverage.
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
    // The tier must not be parasitic on `resolveProjectId`: a config blob
    // carrying a bucket and no projectId still resolves.
    vi.stubEnv('FIREBASE_CONFIG', JSON.stringify({ storageBucket: 'only.firebasestorage.app' }));
    expect(storageBucketNameOrNull()).toBe('only.firebasestorage.app');
  });
});

/**
 * The degradation the mass-import job depends on: an unresolvable bucket NAME is
 * "skip photos for this run", not a failed import.
 *
 * ⚠️ This is the ONE branch of `tryGetAdminBucket` a unit test can reach — it
 * answers before `getStorage`/`getAdminApp` is ever called, which is also why it
 * is safe to call here with no credentials in the environment. A refactor that
 * built the bucket first and checked the name afterwards would initialise an
 * admin app in every unit run, and this test is what says so.
 */
describe('tryGetAdminBucket', () => {
  beforeEach(() => {
    for (const name of BUCKET_LADDER_ENV) vi.stubEnv(name, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null — without touching the admin app — when the NAME is unresolvable', () => {
    expect(tryGetAdminBucket()).toBeNull();
  });
});

/**
 * The shared `FIREBASE_CONFIG` reader, tested DIRECTLY.
 *
 * ⚠️ Not redundant with the ladder tests above, and mutation testing is what
 * proved it on the Mercado Livre copy: both public callers guard the result with
 * `if (value)`, so an empty string is swallowed downstream and dropping the
 * helper's own `&& value` reds NOTHING through them.
 */
describe('firebaseConfigValue', () => {
  beforeEach(() => {
    vi.stubEnv('FIREBASE_CONFIG', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads both keys out of the blob the deployed runtime injects', () => {
    vi.stubEnv(
      'FIREBASE_CONFIG',
      JSON.stringify({
        databaseURL: '',
        projectId: 'projeto-de-teste',
        storageBucket: 'projeto-de-teste.firebasestorage.app',
      }),
    );
    expect(firebaseConfigValue('projectId')).toBe('projeto-de-teste');
    expect(firebaseConfigValue('storageBucket')).toBe('projeto-de-teste.firebasestorage.app');
  });

  it('returns null for an EMPTY value rather than handing back the empty string', () => {
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
