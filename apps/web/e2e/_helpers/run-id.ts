/**
 * Per-run identifier — unique enough to avoid collisions when multiple
 * Playwright runs hit the same Firebase staging project in parallel. CI uses
 * the GitHub run id; local runs fall back to a base36 timestamp.
 */
export function getRunId(): string {
  return process.env.GITHUB_RUN_ID ?? Date.now().toString(36);
}
