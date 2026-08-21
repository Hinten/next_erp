/**
 * Resolving the Google Cloud region a Cloud Tasks enqueue must target.
 *
 * ⚠️ **There is deliberately no default region anywhere in this repo.** Every
 * enqueuer used to end its lookup chain in a literal — `?? 'us-east1'`,
 * `?? 'us-east5'` — and that literal is how the project drifted into three
 * regions without anything ever failing.
 *
 * The failure mode a default hides is completely silent. `getFunctions()
 * .taskQueue(name)` given an unqualified or wrong-region name resolves
 * `us-central1` in the Admin SDK; the queue does not exist there; the task is
 * **dropped**, and the calling route still answers 200. Nothing throws, nothing
 * is logged as an error, and the work simply never happens (#1108, and the
 * 2026-08-19 Mercado Livre deploy that failed 11 of 15 functions on the same
 * class of mismatch). A wrong region is therefore strictly worse than no region:
 * one loses work invisibly, the other stops.
 *
 * So this throws. A misconfigured backend fails loudly on its first enqueue,
 * which is recoverable, instead of accepting writes it silently discards.
 *
 * ⚠️ Reached only through the `@delfrance/core/region` subpath, never the root
 * barrel — same rule as `./cep`, and `index.barrel.test.ts` enforces it. Core's
 * root is reachable from every browser bundle in the monorepo (via
 * `@delfrance/schemas`), and this module reads `process.env` for a server-only
 * concern that no client bundle has any business pulling in.
 */

/** Thrown when no candidate variable supplies a region. Narrow on it (rule 6). */
export class MissingRegionError extends Error {
  /** The variables that were consulted, in order. */
  readonly candidates: readonly string[];

  constructor(message: string, candidates: readonly string[]) {
    super(message);
    this.name = 'MissingRegionError';
    this.candidates = candidates;
  }
}

/**
 * First non-blank value among `candidates`, or throw.
 *
 * The chain is ordered most- to least-specific — typically a per-queue override
 * followed by the codebase-wide region — so a deployment that needs its queues in
 * a different region from its triggers can say so, and one that does not can set
 * a single variable.
 *
 * Blank counts as unset: an exported-but-empty variable is a misconfiguration
 * that should fail the same way a missing one does, never pass for configured.
 * Values are trimmed because they are interpolated into a
 * `locations/<region>/functions/<queue>` path, where a stray space produces a
 * queue name that cannot match.
 *
 * ⚠️ `env` is a REQUIRED parameter, not a defaulted `process.env`. This package
 * is browser-reachable and carries no node types on purpose, so reading an
 * ambient `process` here would either break its typecheck or quietly widen what
 * a client bundle assumes exists. Passing it also makes the dependency visible at
 * every call site and leaves tests with no global to restore.
 *
 * @param candidates Variable names to consult, most specific first.
 * @param env The environment to read — `process.env` on every current caller.
 * @throws {MissingRegionError} When every candidate is unset or blank.
 */
export function requireRegion(
  candidates: readonly string[],
  env: Record<string, string | undefined>,
): string {
  for (const name of candidates) {
    const value = env[name]?.trim();
    if (value) return value;
  }

  const [primary] = candidates;
  throw new MissingRegionError(
    [
      `No Cloud Tasks region configured: ${candidates.join(' and ')} ` +
        `${candidates.length === 1 ? 'is' : 'are'} unset.`,
      '',
      'There is no default on purpose. An enqueue against the wrong region does',
      'not fail — the Admin SDK resolves us-central1, the queue does not exist,',
      'and the task is dropped while this request still returns 200 (#1108). A',
      'refused enqueue is the only visible outcome available.',
      '',
      `Set ${primary} on this backend (apphosting.yaml, the Cloud Run service, or`,
      'the shell for a local run) to the region its queue was created in — the',
      'same region the corresponding onTaskDispatched function is deployed to.',
    ].join('\n'),
    candidates,
  );
}
