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
 * `@delfrance/schemas`), and this is a server-only concern no client bundle has
 * any business pulling in.
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
 * ⚠️ **Takes RESOLVED VALUES, not variable names or an env object, and that is
 * load-bearing rather than stylistic.** Every functions codebase is bundled by
 * esbuild with `define: { 'process.env.FUNCTIONS_REGION': '"<region>"' }`, which
 * substitutes the **static member expression** `process.env.X` and nothing else.
 * An earlier version of this function took `(names, process.env)` and indexed the
 * env dynamically — `define` cannot see through that, so the region silently
 * stopped being inlined and every deployed enqueue threw, while CI stayed green
 * because the emulator lanes have the variable in the shell.
 *
 * So callers pass an object literal whose VALUES are `process.env.X` reads:
 *
 * ```ts
 * requireRegion({
 *   BALANCO_TASKS_REGION: process.env.BALANCO_TASKS_REGION,
 *   FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,
 * });
 * ```
 *
 * Each value is a static member expression the bundler can replace, while the
 * KEYS give this function the names to put in the error message. Order is the
 * candidate order — most specific first — and object key order is guaranteed for
 * string keys, so a per-queue override still wins over the codebase-wide region.
 * `tools/deploy-env/bundle-inlining.test.js` proves the substitution survives.
 *
 * Blank counts as unset: an exported-but-empty variable is a misconfiguration
 * that should fail the same way a missing one does, never pass for configured.
 * Values are trimmed because they are interpolated into a
 * `locations/<region>/functions/<queue>` path, where a stray space produces a
 * queue name that cannot match.
 *
 * @param candidates Variable name → its resolved value, most specific first.
 * @throws {MissingRegionError} When every candidate is unset or blank.
 */
export function requireRegion(candidates: Record<string, string | undefined>): string {
  const names = Object.keys(candidates);

  for (const name of names) {
    const value = candidates[name]?.trim();
    if (value) return value;
  }

  const [primary] = names;
  throw new MissingRegionError(
    [
      `No Cloud Tasks region configured: ${names.join(' and ')} ` +
        `${names.length === 1 ? 'is' : 'are'} unset.`,
      '',
      'There is no default on purpose. An enqueue against the wrong region does',
      'not fail — the Admin SDK resolves us-central1, the queue does not exist,',
      'and the task is dropped while this request still returns 200 (#1108). A',
      'refused enqueue is the only visible outcome available.',
      '',
      `Set ${primary} on this backend (apphosting.yaml, the Cloud Run service, or`,
      'the shell for a local run) to the region its queue was created in — the',
      'same region the corresponding onTaskDispatched function is deployed to.',
      '',
      'Inside a FUNCTIONS codebase it comes from the esbuild `define` instead, so',
      'an unset value there means the build did not inline it — check build.mjs.',
    ].join('\n'),
    names,
  );
}
