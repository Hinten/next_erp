import { e2eRunSlotSuffix } from '@delfrance/test-fixtures';

/**
 * Per-run identifier — unique enough to avoid collisions when multiple
 * Playwright runs hit the same Firebase staging project in parallel. CI uses
 * the GitHub run id; local runs fall back to a base36 timestamp.
 *
 * ⚠️ Carries {@link e2eRunSlotSuffix}, and MUST keep carrying it. Two sharded
 * jobs of one workflow run share `GITHUB_RUN_ID`, and every doc id, fixture name
 * and the ephemeral auth user hang off this value — so without the slot the job
 * that finishes first sweeps `e2e-<runId>-` and deletes its sibling's LIVE
 * fixtures. See the `e2eRunSlot` docblock in `tools/test-fixtures/src/admin.ts`
 * for all three axes that have to move together.
 */
export function getRunId(): string {
  return `${process.env.GITHUB_RUN_ID ?? Date.now().toString(36)}${e2eRunSlotSuffix()}`;
}

/**
 * Index of the Playwright worker process this code is running in.
 *
 * Playwright sets `TEST_WORKER_INDEX` per worker and hands each **retry** a
 * FRESH worker with a NEW index — which is exactly the property
 * {@link e2ePrefix} needs. Defaults to `'0'` outside a worker (nothing in
 * `globalSetup`/`globalTeardown` calls it today; they sweep by run id).
 */
export function workerIndex(): string {
  return process.env.TEST_WORKER_INDEX ?? '0';
}

/**
 * Email of the ephemeral Firebase Auth user for this run. `globalSetup`
 * creates it, `globalTeardown` deletes it — both derive the address from
 * here so they agree. The run id keeps parallel runs from colliding;
 * `example.com` is a reserved domain (valid format, no real mailbox needed —
 * the Admin SDK sets `emailVerified`).
 */
export function e2eUserEmail(): string {
  return `e2e-user-${getRunId()}@example.com`;
}
