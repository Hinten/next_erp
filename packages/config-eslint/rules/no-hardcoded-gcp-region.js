/**
 * A Google Cloud region id may not appear as a string literal in source.
 *
 * WHY. The region used to be a hardcoded fallback in 23 files — `|| 'us-east1'`,
 * `?? 'us-east5'` — and that is how this project ended up running Cloud Functions,
 * Cloud Tasks queues and Firestore in THREE regions without a single failure to
 * point at. Every cross-region hop is billed as inter-region data transfer, and the
 * mistake surfaced on an invoice rather than in a log.
 *
 * The reason it stayed hidden is that both halves fail silently. A function deployed
 * to the wrong region deploys fine. An enqueue against the wrong region does not
 * raise: `getFunctions().taskQueue()` resolves `us-central1`, the queue does not
 * exist there, and the task is DROPPED while the route still returns 200 (#1108).
 * The one time it WAS loud — 11 of 15 Mercado Livre functions failing on
 * 2026-08-19 — it was loud only because a deploy refuses what a runtime swallows.
 *
 * So a wrong region is strictly worse than no region: one loses work invisibly, the
 * other stops. The region belongs in the environment, read through
 * `requireRegion` (`@delfrance/core/region`) or `requireBuildRegion`
 * (`tools/deploy-env/build-env.mjs`), both of which THROW when it is unset.
 *
 * WHAT IS FLAGGED. A string literal — or a single-part template literal — whose
 * whole text is a GCP region id (`us-central1`, `southamerica-east1`,
 * `europe-west4`, …) or a Firestore multi-region id (`nam5`, `nam7`, `eur3`).
 *
 * WHAT IS DELIBERATELY NOT FLAGGED:
 *   - Comments and docs. They explain the history and must be free to name a
 *     region; ESLint never visits them here.
 *   - Test files. A test asserting `locations/<region>/functions/<queue>` has to
 *     write a region somewhere, and stubbing one is how the resolvers are covered
 *     at all. `isTestFile` mirrors `no-lossy-date-parse.js` / `no-ambient-timezone.js`.
 *   - `REGIONS_WITHOUT_TASKS` in `tools/deploy-env/preflight.mjs` — a measured guard
 *     listing regions that lack Cloud Tasks. It must name one to be useful.
 *   - A region embedded in a longer string (a URL, a full queue path). The value
 *     that decides behaviour is the bare id; a URL is a different kind of constant
 *     and matching inside it would flag documentation strings.
 *
 * WHAT THIS DOES NOT COVER, and what does. Config files legitimately hold the
 * literal — that is where a per-project value belongs — so workflows,
 * `apphosting.yaml` and `.env*` are out of scope by construction. The risk THERE is
 * the opposite one: a surface that forgets to supply the variable now breaks the
 * build. `no-hardcoded-gcp-region-workflows.test.js` is that backstop.
 *
 * SEVERITY: error. There are zero remaining sites, so it cannot be a ratchet — and
 * the failure it guards is silent data loss plus a recurring bill.
 */

/**
 * A bare GCP region id: `<geo>-<compass><n>`.
 *
 * Anchored on both ends, so `https://us-central1-run.app` and
 * `locations/us-central1/functions/x` do not match — see the doc block. Kept as one
 * pattern rather than a list of known regions: Google adds regions continuously, and
 * a list would silently stop covering the newest ones, which are exactly the ones
 * someone is most likely to paste in from a console.
 */
const REGION_ID =
  /^(?:africa|asia|australia|europe|me|northamerica|southamerica|us)-(?:central|east|north|northeast|south|southeast|southwest|west)\d+$/;

/** Firestore multi-region ids. A closed set, so it is spelled out. */
const MULTI_REGION = new Set(['nam5', 'nam7', 'eur3']);

/** Its own subject: the guard that must name a region to mean anything. */
const ALLOW_LIST = ['/tools/deploy-env/preflight.mjs', '/packages/config-eslint/rules/'];

/** Test, spec and e2e-helper files pin regions deliberately. */
function isTestFile(filename) {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(filename) ||
    filename.includes('/e2e/') ||
    filename.includes('/__tests__/') ||
    filename.includes('/test/')
  );
}

function isRegionId(value) {
  return typeof value === 'string' && (REGION_ID.test(value) || MULTI_REGION.has(value));
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A Google Cloud region must come from the environment and throw when unset, ' +
        'never from a string literal in source.',
    },
    schema: [],
    messages: {
      hardcoded:
        "'{{region}}' is a hardcoded Google Cloud region. Read it from the environment " +
        'instead: `requireRegion([...], process.env)` from `@delfrance/core/region` at ' +
        'runtime, or `requireBuildRegion(...)` from `tools/deploy-env/build-env.mjs` in a ' +
        'build script — both THROW when it is unset. A literal here is how this repo ended ' +
        'up in three regions: a function deployed to the wrong one still deploys, and an ' +
        'enqueue against the wrong one is dropped while the route returns 200 (#1108).',
    },
  },
  create(context) {
    const filename = (context.filename ?? context.getFilename?.() ?? '').replace(/\\/g, '/');
    if (ALLOW_LIST.some((allowed) => filename.includes(allowed)) || isTestFile(filename)) {
      return {};
    }

    return {
      Literal(node) {
        if (!isRegionId(node.value)) return;
        context.report({ node, messageId: 'hardcoded', data: { region: node.value } });
      },

      // Only a template with no interpolation: `` `us-east1` `` is the same
      // constant written differently. One WITH interpolation is being assembled
      // from parts, which is the dataflow case this rule deliberately leaves alone.
      TemplateLiteral(node) {
        if (node.expressions.length > 0 || node.quasis.length !== 1) return;
        const text = node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
        if (!isRegionId(text)) return;
        context.report({ node, messageId: 'hardcoded', data: { region: text } });
      },
    };
  },
};

export default rule;
