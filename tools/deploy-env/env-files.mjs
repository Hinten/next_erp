/**
 * Which `.env*` files a Cloud Functions deploy artifact may contain — the single
 * source of truth for all five `prepare-deploy.mjs` scripts.
 *
 * WHY THIS IS SHARED. The five scripts are hand-duplicated copies of one ~60-line
 * body, and duplicating this particular decision is exactly how it drifts. It used
 * to be spelled, in `apps/nfe/functions/scripts/prepare-deploy.mjs` only, as a
 * DENYLIST — `f.startsWith('.env') && f !== '.env.local' && f !== '.env.example'`
 * — which made every `.env*` name the repo ever invents opt-OUT of being shipped
 * to the cloud. `.env.secrets`, `.env.staging`, `.env.bak` and `.env.secrets.example`
 * all matched. That default is backwards: a deploy config ships
 * `"ignore": ["node_modules"]` and nothing else, so whatever lands in the artifact
 * is uploaded to the project's `gcf-sources-*` bucket AND baked in plaintext into
 * the Cloud Run revision, readable by anyone with viewer-level IAM.
 *
 * THE PARTITION IS TOTAL — every `.env*` name lands in exactly one of four buckets,
 * and there is no silent fallthrough in either direction:
 *
 *   .env.deploy               → copy, renamed to `.env` in the artifact
 *   .env.deploy.<project-id>  → copy, renamed to `.env.<project-id>`
 *   .env.local / .env.example → ignore (emulator seed / doc template; pre-existing meaning)
 *   .env.secrets*             → REJECT, fail the predeploy hook
 *   .env / any other .env.*   → REJECT, telling the operator to rename
 *
 * WHY THE RENAME. firebase-tools reads exactly `.env`, `.env.<project-id>` and
 * `.env.<alias>` from the functions source directory. A file literally named
 * `.env.deploy` sitting in the artifact would be uploaded and then ignored. Keeping
 * the SOURCE name distinct from the DESTINATION name is what makes the source file
 * unmistakable on an operator's disk — and it means this module never has to learn
 * the project id: it strips the `.deploy` infix and lets firebase-tools pick the
 * right file at deploy time from the actual `--project`.
 *
 * WHY `.env` ITSELF IS REJECTED RATHER THAN IGNORED. It used to be the documented
 * nfe source filename (`apps/nfe/functions/.env`). It is gitignored, so no such file
 * exists in the repo — but it does exist on operator machines, and silently ceasing
 * to copy it would stop shipping `NFE_CERT_ENV_FALLBACK=1` with no signal at all.
 * A loud predeploy failure naming the rename is the only honest migration.
 */

import { copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Pre-existing meanings, preserved: neither has ever been copied. */
const IGNORED = new Set(['.env.local', '.env.example']);

/**
 * `.env.deploy` or `.env.deploy.<project-id>`. Anchored on both ends and restricted
 * to the GCP project-id charset — never a `startsWith` prefix match, which is the
 * bug this module exists to retire.
 */
const DEPLOY_RE = /^\.env\.deploy(?:\.([a-z0-9-]+))?$/;

/**
 * Suffixes that are legal project-id characters but would produce an artifact file
 * with a RESERVED firebase-tools meaning: `.env.deploy.example` → `.env.example`
 * (a doc template, uploaded for nothing) and `.env.deploy.local` → `.env.local`
 * (which firebase-tools applies to the emulator, never to a deploy). Both are
 * operator mistakes worth naming rather than silently honouring.
 */
const RESERVED_SUFFIXES = new Set(['example', 'local']);

/** Any `.env*` name that is not one of the above — see `classifyEnvFile`. */
const SECRETS_PREFIX = '.env.secrets';
const DOTENV_RE = /^\.env(\..+)?$/;

/**
 * @param {string} name  A bare filename (no directory part).
 * @returns {{action: 'copy', dest: string} | {action: 'ignore'} | {action: 'reject', reason: string}}
 */
export function classifyEnvFile(name) {
  // Not a dotenv file at all. `.envrc` (direnv) lands here on purpose: it starts
  // with `.env` — and the old denylist therefore shipped it — but it is not a
  // dotenv file and has no business being classified as one.
  if (!DOTENV_RE.test(name)) return { action: 'ignore' };

  if (name.startsWith(SECRETS_PREFIX)) {
    return {
      action: 'reject',
      reason:
        `"${name}" holds credential material and must never reach a deploy artifact. ` +
        'Everything in the artifact is uploaded to the gcf-sources bucket and baked ' +
        'in plaintext into the Cloud Run revision. Put these values in Secret Manager ' +
        '(`firebase functions:secrets:set <NAME>`) and delete the file.',
    };
  }

  const match = DEPLOY_RE.exec(name);
  if (match) {
    const projectId = match[1];
    if (projectId === undefined) return { action: 'copy', dest: '.env' };
    if (RESERVED_SUFFIXES.has(projectId)) {
      return {
        action: 'reject',
        reason:
          `"${name}" would become ".env.${projectId}" in the artifact, which firebase-tools ` +
          'reserves for a different purpose. Pick a real project id as the suffix.',
      };
    }
    return { action: 'copy', dest: `.env.${projectId}` };
  }

  if (IGNORED.has(name)) return { action: 'ignore' };

  return {
    action: 'reject',
    reason:
      `"${name}" is not copied into the deploy artifact. Rename it to ".env.deploy" ` +
      '(applied to every project) or ".env.deploy.<project-id>" (applied to that ' +
      'project only) — prepare-deploy.mjs strips the ".deploy" infix so firebase-tools ' +
      'sees the name it actually reads.',
  };
}

/**
 * Copy the allowlisted env files from a functions package dir into its deploy
 * artifact, throwing on anything rejected. Call it AFTER the artifact dir is wiped
 * and recreated — the wipe is what used to eat a hand-placed file.
 *
 * @param {string} pkgDir     e.g. <root>/apps/nfe/functions
 * @param {string} deployDir  e.g. <root>/.deploy/nfe-functions
 * @returns {string[]} human-readable `source → dest` lines, for the progress log.
 */
export function copyDeployEnv(pkgDir, deployDir) {
  const copied = [];

  // Sorted so the throw order — and the log — are deterministic across platforms.
  const entries = readdirSync(pkgDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const entry of entries) {
    const verdict = classifyEnvFile(entry.name);

    // Deliberately checked BEFORE isFile(): a *directory* named `.env.secrets` is
    // every bit as much a red flag as a file, and silently skipping it would be
    // the same class of bug as the denylist.
    if (verdict.action === 'reject') {
      throw new Error(`prepare-deploy: refusing to build the artifact — ${verdict.reason}`);
    }
    if (verdict.action !== 'copy') continue;

    if (!entry.isFile()) {
      throw new Error(
        `prepare-deploy: refusing to build the artifact — "${entry.name}" is not a regular file.`,
      );
    }

    copyFileSync(join(pkgDir, entry.name), join(deployDir, verdict.dest));
    copied.push(`${entry.name} → ${verdict.dest}`);
  }

  return copied;
}
