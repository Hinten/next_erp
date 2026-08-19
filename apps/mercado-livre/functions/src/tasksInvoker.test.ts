import { afterEach, describe, expect, it } from 'vitest';

import { tasksInvokerOptions } from './tasksInvoker';

/**
 * `tasksInvokerOptions()` decides, per deploy, who may enqueue AND dispatch this
 * codebase's task functions (#1133). Both failure directions are silent in
 * production, which is why the shape is asserted here rather than trusted:
 *
 *  - a MISSING key leaves `roles/run.invoker` to the manual gcloud grant — the
 *    documented status quo, and the one that fails at DISPATCH with no failure
 *    document written anywhere;
 *  - a key present with a bad value is WORSE than missing, because the deploy
 *    REPLACES the binding's members and revokes whoever was legitimately there.
 *
 * The module is deliberately side-effect free and reads the env at CALL time, so
 * unlike `options.ts` it needs no `FUNCTIONS_REGION` stub and no module reset.
 */
const original = process.env.TASKS_INVOKER_SA;

afterEach(() => {
  if (original === undefined) delete process.env.TASKS_INVOKER_SA;
  else process.env.TASKS_INVOKER_SA = original;
});

function optionsWith(value: string | undefined): { invoker?: string[] } {
  if (value === undefined) delete process.env.TASKS_INVOKER_SA;
  else process.env.TASKS_INVOKER_SA = value;
  return tasksInvokerOptions();
}

describe('tasksInvokerOptions (#1133)', () => {
  it('omits the key entirely when TASKS_INVOKER_SA is unset', () => {
    const options = optionsWith(undefined);

    // ⚠️ NOT `toBeUndefined()`. `{ invoker: undefined }` would pass that and
    // still CRASH the deploy: firebase-functions copies the option with
    // `hasOwnProperty`, so an explicitly-undefined key reaches
    // `convertInvoker(undefined)` and throws during codebase analysis.
    expect('invoker' in options).toBe(false);
    expect(options).toEqual({});
  });

  it('omits the key when the value is blank or only separators', () => {
    for (const blank of ['', '   ', ',', ' , , ']) {
      expect('invoker' in optionsWith(blank)).toBe(false);
    }
  });

  it('carries a single service account', () => {
    const options = optionsWith('svc@example-project.iam.gserviceaccount.com');

    expect(options).toEqual({ invoker: ['svc@example-project.iam.gserviceaccount.com'] });
  });

  it('carries EVERY service account in a comma-separated list, trimmed', () => {
    // The list must name both enqueuers — the App Hosting runtime SA (the
    // receiver routes) and the functions runtime SA (the sweeps, the Firestore
    // triggers and every self-continuation). A deploy REPLACES the binding's
    // members, so an identity dropped from here loses the role.
    const options = optionsWith(
      ' apphosting@p.iam.gserviceaccount.com , 1-compute@developer.gserviceaccount.com ',
    );

    expect(options).toEqual({
      invoker: ['apphosting@p.iam.gserviceaccount.com', '1-compute@developer.gserviceaccount.com'],
    });
  });

  it('drops a BLANK member from a list rather than passing it through', () => {
    // `filter(Boolean)` is load-bearing, not tidiness. firebase-functions@7.3.2
    // ACCEPTS a blank member — `convertInvoker(['', 'a@…'])` returns it verbatim,
    // because its guard `find((inv) => inv.length === 0)` yields `''`, which is
    // falsy, leaving the "Must be a non-empty string" branch unreachable. So a
    // stray comma would sail through codebase analysis and only break later, in
    // firebase-tools' `formatServiceAccount` at DEPLOY time.
    const options = optionsWith(
      'apphosting@p.iam.gserviceaccount.com, ,1-compute@developer.gserviceaccount.com',
    );

    expect(options.invoker).toEqual([
      'apphosting@p.iam.gserviceaccount.com',
      '1-compute@developer.gserviceaccount.com',
    ]);
    expect(options.invoker).not.toContain('');
  });

  it('spreads into a function options object without adding an `invoker` key when unset', () => {
    // The call-site shape: `{ ...tasksInvokerOptions(), retryConfig }`.
    const options = { ...optionsWith(undefined), retryConfig: { maxAttempts: 3 } };

    expect('invoker' in options).toBe(false);
  });
});
