import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BUILD_ENV_FILE,
  BUILD_ENV_KEYS,
  BuildEnvError,
  loadBuildEnv,
  parseBuildEnv,
} from './build-env.mjs';
import { CODEBASES } from './preflight.mjs';

/**
 * `.env.functions` exists to stop an operator from having to remember an `export`.
 * The risk it introduces is that a file the build READS is also a file a
 * credential can be pasted into — and whatever lands in `process.env` here is
 * inlined into a bundle that ships to a public-ish bucket and a Cloud Run
 * revision. So the allow-list is the subject of most of these tests.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const temps = [];
function withFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'build-env-'));
  temps.push(dir);
  if (contents !== null) writeFileSync(join(dir, BUILD_ENV_FILE), contents);
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

describe('loading', () => {
  it('is a silent no-op when the file does not exist', () => {
    // CI lanes, fresh clones and the emulator artifact build all run without one.
    const env = {};
    const result = loadBuildEnv(withFile(null), env);

    expect(result).toEqual({ file: null, applied: [], skipped: [] });
    expect(env).toEqual({});
  });

  it('applies a value the environment does not already have', () => {
    const env = {};
    const result = loadBuildEnv(withFile('FUNCTIONS_REGION=us-east1\n'), env);

    expect(env.FUNCTIONS_REGION).toBe('us-east1');
    expect(result.applied).toEqual(['FUNCTIONS_REGION']);
  });

  it('lets the REAL environment win', () => {
    // CI exports these directly; a one-off `FUNCTIONS_REGION=… firebase deploy`
    // must still override the file.
    const env = { FUNCTIONS_REGION: 'europe-west4' };
    const result = loadBuildEnv(withFile('FUNCTIONS_REGION=us-east1\n'), env);

    expect(env.FUNCTIONS_REGION).toBe('europe-west4');
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['FUNCTIONS_REGION']);
  });

  it('treats a BLANK exported value as unset, matching build.mjs `||`', () => {
    const env = { FUNCTIONS_REGION: '   ' };
    loadBuildEnv(withFile('FUNCTIONS_REGION=us-east1\n'), env);

    expect(env.FUNCTIONS_REGION).toBe('us-east1');
  });

  it('ignores a blank entry in the file rather than setting an empty string', () => {
    // The template ships every key with an empty value; those lines must not
    // shadow a real export or produce `invoker: [""]`.
    const env = {};
    loadBuildEnv(withFile('FUNCTIONS_REGION=\nTASKS_INVOKER_SA=  \n'), env);

    expect('FUNCTIONS_REGION' in env).toBe(false);
    expect('TASKS_INVOKER_SA' in env).toBe(false);
  });
});

describe('parsing', () => {
  it('survives CRLF', () => {
    // ⚠️ core.autocrlf=true here. A `'\n'` split would leave a trailing `\r` on
    // every value and inline it into the bundle. The same bug once made
    // env-example-split.test.js pass vacuously for every local developer.
    const entries = parseBuildEnv('FUNCTIONS_REGION=us-east1\r\nNFE_TASKS_REGION=us-east4\r\n');

    expect(entries).toEqual([
      { key: 'FUNCTIONS_REGION', value: 'us-east1' },
      { key: 'NFE_TASKS_REGION', value: 'us-east4' },
    ]);
  });

  it('strips ONE pair of surrounding quotes', () => {
    // This repo's own .env.local writes FIREBASE_PROJECT_ID="veste-france-debug",
    // so an operator will copy that habit.
    expect(parseBuildEnv('FUNCTIONS_REGION="us-east1"\n')[0].value).toBe('us-east1');
    expect(parseBuildEnv("FUNCTIONS_REGION='us-east1'\n")[0].value).toBe('us-east1');
    // A quote that is not a matching pair is data, not syntax.
    expect(parseBuildEnv('FUNCTIONS_REGION="us-east1\n')[0].value).toBe('"us-east1');
  });

  it('skips comments and blank lines', () => {
    expect(parseBuildEnv('# FUNCTIONS_REGION=nope\n\n  \nNFE_TASKS_REGION=us-east1\n')).toEqual([
      { key: 'NFE_TASKS_REGION', value: 'us-east1' },
    ]);
  });
});

describe('the allow-list is what keeps a credential out', () => {
  it('refuses an unknown key, naming it', () => {
    const env = {};

    expect(() => loadBuildEnv(withFile('MERCADO_LIVRE_CLIENT_SECRET=hunter2\n'), env)).toThrow(
      BuildEnvError,
    );
    expect(env).toEqual({});
  });

  it('says WHY, and what to do about it', () => {
    // The message is the deliverable: an operator who pasted a secret needs to be
    // told it would have shipped, not just that the key is unknown.
    let message = '';
    try {
      loadBuildEnv(withFile('SOME_TOKEN=abc\n'), {});
    } catch (err) {
      if (!(err instanceof BuildEnvError)) throw err;
      message = err.message;
    }

    expect(message).toContain('SOME_TOKEN');
    expect(message).toContain('BUILD_ENV_KEYS');
    expect(message).toMatch(/Cloud Run revision|shipped/);
  });

  it('refuses the WHOLE file — no key is applied when one is unknown', () => {
    // Partial application would leave the operator with a half-loaded env and a
    // deploy that behaves differently from what the file says.
    const env = {};

    expect(() =>
      loadBuildEnv(withFile('FUNCTIONS_REGION=us-east1\nSOME_TOKEN=abc\n'), env),
    ).toThrow(BuildEnvError);
    expect(env).toEqual({});
  });

  it('refuses a SHELL-ONLY key, telling the operator to export it', () => {
    // ⚠️ The defect this test exists for: `rateLimits` is read by firebase-tools'
    // trigger analysis, a SIBLING process that inherits the deploy shell — not
    // this hook. Accepting these would have produced a value that looks
    // configured and is not, which is the failure class the preflight exists to
    // remove. Also unreachable by `define`: `envInt` uses `process.env[name]`,
    // computed access, which esbuild cannot rewrite.
    let message = '';
    try {
      loadBuildEnv(withFile('MERCADO_LIVRE_STOCK_DISPATCHES_PER_SECOND=4\n'), {});
    } catch (err) {
      if (!(err instanceof BuildEnvError)) throw err;
      message = err.message;
    }

    expect(message).toContain('TRIGGER ANALYSIS');
    expect(message).toContain('deploy shell');
  });

  it('refuses a RUNTIME key, pointing at .env.deploy', () => {
    // No build.mjs defines these; each options.ts defaults them at module load
    // inside the deployed function. Setting them here would do nothing at all.
    let message = '';
    try {
      loadBuildEnv(withFile('BALANCO_TASKS_REGION=us-east1\n'), {});
    } catch (err) {
      if (!(err instanceof BuildEnvError)) throw err;
      message = err.message;
    }

    expect(message).toContain('RUNTIME');
    expect(message).toContain('.env.deploy');
  });

  it('accepts ONLY what a build.mjs actually inlines', () => {
    // The allow-list must equal the union of every `define`d name across the five
    // builds. Derived here from preflight's CODEBASES — which its own test already
    // proves total against each build.mjs — so a new define cannot leave this set
    // stale, and a name that is NOT inlined cannot be advertised as settable.
    const inlined = new Set(Object.values(CODEBASES).flatMap((spec) => Object.keys(spec.inlined)));
    // TASKS_INVOKER_SA is define'd by all five but deliberately kept out of
    // `inlined` (it is the preflight's own subject), so add it back.
    inlined.add('TASKS_INVOKER_SA');

    expect([...BUILD_ENV_KEYS].sort()).toEqual([...inlined].sort());
  });

  it('holds no key that looks like credential material', () => {
    // Same rule env-example-split.test.js uses to sort the two root templates.
    // TASKS_INVOKER_SA is a service-account EMAIL — an identifier, not a key.
    const SECRET_SUFFIX_RE = /(SECRET|PASSWORD|_TOKEN|PRIVATE_KEY|CERT_BASE64|ENC_KEY)$/;
    const offenders = [...BUILD_ENV_KEYS].filter((k) => SECRET_SUFFIX_RE.test(k));

    expect(
      offenders,
      'a credential-shaped key must never be loadable from a file the build reads',
    ).toEqual([]);
  });
});

describe('the template and the allow-list stay in sync', () => {
  // Otherwise the example rots: a key is added to one and the other keeps
  // documenting — or accepting — a different set.
  const templateKeys = parseBuildEnv(
    readFileSync(resolve(REPO_ROOT, `${BUILD_ENV_FILE}.example`), 'utf8'),
  ).map((e) => e.key);

  it('documents every accepted key', () => {
    const missing = [...BUILD_ENV_KEYS].filter((k) => !templateKeys.includes(k));
    expect(missing, `${BUILD_ENV_FILE}.example does not document these`).toEqual([]);
  });

  it('documents nothing the loader would refuse', () => {
    const extra = templateKeys.filter((k) => !BUILD_ENV_KEYS.has(k));
    expect(extra, `${BUILD_ENV_FILE}.example documents keys the loader rejects`).toEqual([]);
  });

  it('ships every key BLANK, so copying the template configures nothing by accident', () => {
    const filled = parseBuildEnv(
      readFileSync(resolve(REPO_ROOT, `${BUILD_ENV_FILE}.example`), 'utf8'),
    ).filter((e) => e.value !== '');
    expect(filled.map((e) => e.key)).toEqual([]);
  });
});
