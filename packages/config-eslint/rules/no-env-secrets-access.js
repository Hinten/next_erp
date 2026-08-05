/**
 * Nothing in this repo may read, copy, glob or resolve a `.env.secrets*` file.
 *
 * WHY. `.env.secrets.example` is the committed template for the repo's credential
 * material (OAuth client secrets, HMAC state secrets, the Firebase service account,
 * the A1 cert password + its at-rest encryption key). Its filled-in sibling is
 * gitignored and lives only on a developer's disk. The one thing that must never
 * happen is a build step picking either of them up: a Cloud Functions deploy config
 * ships `"ignore": ["node_modules"]` and nothing else, so whatever a predeploy hook
 * writes into the artifact is uploaded to the project's `gcf-sources-*` bucket AND
 * baked in plaintext into the Cloud Run revision, readable by anyone with
 * viewer-level IAM.
 *
 * That is not hypothetical. `apps/nfe/functions/scripts/prepare-deploy.mjs` used to
 * copy `.env*` by DENYLIST — `f.startsWith('.env') && f !== '.env.local' && f !==
 * '.env.example'` — so every new `.env*` name the repo invented was opt-OUT of being
 * shipped to the cloud. This rule exists so the next such loop cannot be written.
 *
 * WHAT IS FLAGGED. Any string literal or template literal whose text contains
 * `.env.secrets`, anywhere in linted JS/TS — including the `.mjs` deploy scripts,
 * which is the whole point (they are covered by the base config block, not by
 * `typeAware(...)`).
 *
 * WHAT IS DELIBERATELY NOT FLAGGED. A name assembled from fragments (`'.env' +
 * '.secrets'`), or built at runtime from a variable. Chasing those means dataflow
 * analysis, and the threat here is an ordinary copy loop written by someone who did
 * not know the rule — not someone evading it. The backstop test
 * `env-secrets-no-copy.test.js` covers the non-JS surface (workflows, firebase
 * configs, shell scripts) that ESLint cannot parse at all.
 *
 * SEVERITY: error. A warning would not fail CI, and the failure mode this guards is
 * credential material reaching a cloud bucket.
 */

/** The forbidden substring. Matched against string/template text, never a filename. */
const NEEDLE = '.env.secrets';

/**
 * Files whose job IS to name the forbidden pattern. Kept in the rule rather than in
 * a config block's `files`/`ignores` — the house convention (see
 * `no-optional-without-nullable.js`), so the rule holds without every one of the
 * ~23 consuming workspaces having to configure it.
 *
 *  - tools/deploy-env  — the allowlist classifier that REJECTS these files, plus its test.
 *  - packages/config-eslint/rules — this rule, its test, and the backstop test.
 */
const ALLOW_LIST = ['/tools/deploy-env/', '/packages/config-eslint/rules/'];

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Never read, copy or resolve a `.env.secrets*` file — credential material ' +
        'must not be reachable by any build, deploy or test path.',
    },
    schema: [],
    messages: {
      neverTouch:
        'Do not reference `.env.secrets` from code. That file holds credential ' +
        'material and nothing automated may read it: anything a predeploy hook puts ' +
        'in a deploy artifact is uploaded to the gcf-sources bucket and baked in ' +
        'plaintext into the Cloud Run revision. Deploy-time env belongs in ' +
        '`.env.deploy` (see tools/deploy-env/env-files.mjs); real secrets belong in ' +
        'Secret Manager via `firebase functions:secrets:set`.',
    },
  },
  create(context) {
    const filename = (context.filename ?? context.getFilename?.() ?? '').replace(/\\/g, '/');
    if (ALLOW_LIST.some((allowed) => filename.includes(allowed))) return {};

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        if (!node.value.includes(NEEDLE)) return;
        context.report({ node, messageId: 'neverTouch' });
      },

      // Only the static QUASIS, never the whole node's source text: an interpolated
      // `${'.env.secrets'}` is already reported by the Literal visitor above, and
      // reading the full text here would report the same name twice.
      TemplateLiteral(node) {
        const hit = node.quasis.some((quasi) =>
          (quasi.value.cooked ?? quasi.value.raw).includes(NEEDLE),
        );
        if (!hit) return;
        context.report({ node, messageId: 'neverTouch' });
      },
    };
  },
};

export default rule;
