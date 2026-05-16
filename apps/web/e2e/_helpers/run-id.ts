/**
 * Per-run identifier — unique enough to avoid collisions when multiple
 * Playwright runs hit the same Firebase staging project in parallel. CI uses
 * the GitHub run id; local runs fall back to a base36 timestamp.
 */
export function getRunId(): string {
  return process.env.GITHUB_RUN_ID ?? Date.now().toString(36);
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
