import { describe, expect, it } from 'vitest';

import { checkName, jobBlocks, topBlock } from './workflow-scan.js';

/**
 * Unit tests for the shared workflow line-scanner.
 *
 * These run against SYNTHETIC fixtures on purpose. The guards that consume this
 * module assert things about the real `.github/workflows/*`, so they change whenever
 * the workflows do; this file pins the PARSER, which must not change when a workflow
 * does. Same division as `repo-scan.test.js` beside it.
 */

/**
 * The exact shape that produced the false positive this module exists to fix.
 *
 * A file-level comment above `jobs:` naming a scanned command, plus an `on:` block
 * whose sub-keys sit at the same indent as a job id. The naive scanner reported
 * `push` and `pull_request` as jobs and gave the `pull_request` pseudo-job a body
 * running all the way to `build:` — comment included.
 */
const WITH_ON_SUBKEYS = [
  'name: CI',
  '',
  'on:',
  '  push:',
  '    branches: [main]',
  '  pull_request:',
  '    branches: [main]',
  '',
  '# This comment mentions `turbo run build` and FUNCTIONS_REGION, and belongs to',
  '# the file, not to any job.',
  'jobs:',
  '  build:',
  '    name: CI build',
  '    env:',
  '      FUNCTIONS_REGION: us-central1',
  '    steps:',
  '      - run: pnpm turbo run build',
  '',
  '  test:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: pnpm turbo run test',
  '',
].join('\n');

describe('jobBlocks', () => {
  it('returns only real jobs, never `on:` sub-keys', () => {
    const ids = Object.keys(jobBlocks(WITH_ON_SUBKEYS));

    // ⚠️ The regression. `push` and `pull_request` sit at job indent but are not
    // jobs; reporting them produces a confident, specific, FALSE finding that names
    // a job nobody can find. Anchoring to `jobs:` is the whole fix.
    expect(ids).toEqual(['build', 'test']);
    expect(ids).not.toContain('pull_request');
    expect(ids).not.toContain('push');
  });

  it('does not leak the file-level comment above `jobs:` into a job body', () => {
    const jobs = jobBlocks(WITH_ON_SUBKEYS);

    // The naive scanner attached everything between `pull_request:` and the first
    // real job — including this comment — to a pseudo-job, so a guard scanning
    // bodies for a command matched prose. No real job body may contain it.
    for (const [id, body] of Object.entries(jobs)) {
      expect(body, `${id} should not contain the file-level comment`).not.toContain('belongs to');
    }
    // ...while the job that genuinely runs the command still does.
    expect(jobs.build).toContain('pnpm turbo run build');
    expect(jobs.build).toContain('FUNCTIONS_REGION: us-central1');
    // And attribution stays per-job: `test` must NOT inherit build's env.
    expect(jobs.test).not.toContain('FUNCTIONS_REGION');
  });

  it('derives the job indent instead of assuming two spaces', () => {
    const fourSpace = [
      'jobs:',
      '    alpha:',
      '        runs-on: ubuntu-latest',
      '    beta:',
      '        runs-on: ubuntu-latest',
      '',
    ].join('\n');
    expect(Object.keys(jobBlocks(fourSpace))).toEqual(['alpha', 'beta']);
  });

  it('skips a comment when deriving the indent', () => {
    const commentFirst = ['jobs:', '  # leading comment', '  only:', '    runs-on: x', ''].join(
      '\n',
    );
    expect(Object.keys(jobBlocks(commentFirst))).toEqual(['only']);
  });

  it('returns nothing when there is no `jobs:` block', () => {
    expect(jobBlocks('name: CI\non:\n  push:\n    branches: [main]\n')).toEqual({});
  });
});

describe('topBlock', () => {
  it('stops at the next column-0 key', () => {
    const { body } = topBlock(WITH_ON_SUBKEYS, 'on');
    expect(body.some((l) => l.includes('pull_request'))).toBe(true);
    expect(body.some((l) => l.includes('build:'))).toBe(false);
  });

  it('reports an absent block rather than throwing', () => {
    expect(topBlock('name: CI\n', 'jobs')).toEqual({ header: null, body: [] });
  });
});

describe('checkName', () => {
  it('prefers `name:` and falls back to the job id', () => {
    const jobs = jobBlocks(WITH_ON_SUBKEYS);
    expect(checkName('build', jobs.build)).toBe('CI build');
    // `test` declares no `name:`, so GitHub publishes the bare id.
    expect(checkName('test', jobs.test)).toBe('test');
  });

  it('strips surrounding quotes', () => {
    expect(checkName('j', "    name: 'CI test'")).toBe('CI test');
    expect(checkName('j', '    name: "CI test"')).toBe('CI test');
  });
});
