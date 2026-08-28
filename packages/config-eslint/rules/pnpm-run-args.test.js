import { describe, expect, it } from 'vitest';
import { gitGrep } from './lib/repo-scan.js';

/**
 * A documented `pnpm` invocation must not carry a `--` separator before its flags.
 *
 * `pnpm run <script> -- <args>` forwards the literal `--` INTO the script, and every
 * CLI in this repo parses `process.argv` itself, so the documented command dies on
 * its own separator. Verified on the pinned pnpm (11.2.2), not assumed:
 *
 *   $ pnpm --filter @delfrance/mercado-livre-app census:up-single -- --project demo-erp
 *   $ dotenv -e ../../.env.local -- tsx scripts/census-up-single.ts -- --project demo-erp
 *   ❌ Unknown argument: --
 *
 * ⚠️ Removing the separator is safe even for flags pnpm itself defines — `--json`
 * reaches the script (`❌ Unknown argument: --json`, i.e. the SCRIPT rejected it),
 * and `--listar` runs end to end. There is no invocation that needs the separator,
 * which is why this guard has no allowlist beyond the file naming the pattern.
 *
 * ## Why a test rather than a lint rule
 *
 * Same reason as `env-secrets-no-copy.test.js`: most of the surface is Markdown,
 * which ESLint does not parse at all, and failing the test fails CI the same way a
 * lint error would.
 *
 * ## Why it exists at all
 *
 * The defect has been fixed THREE times. `6e73c1d0` swept four Mercado Livre
 * scripts ("Found by actually running dump:notificacoes"); #1351 swept three more;
 * both passes looked only at `apps/mercado-livre/scripts/`, and **35 broken lines
 * across 16 files stood through both** — most of them in `tools/migrations`, whose
 * READMEs are executed by a human during the coordinated migration window (root
 * `CLAUDE.md` rule 8) against production data, in a window that cannot be re-run.
 * `tools/cmun-table/src/import.ts` was the sharpest: the dead command sat inside an
 * ERROR MESSAGE, so the script's own recovery advice failed. A fourth manual sweep
 * was never the fix; the missing guard was.
 *
 * ⚠️ What this must NOT flag: the `--` inside a `package.json` script
 * (`dotenv -e ../../.env.local -- tsx scripts/x.ts`). That one is **dotenv-cli's**
 * own separator and is correct. The pattern below requires a flag on BOTH sides of
 * the separator, so `-- tsx` (a command, not a flag) never matches.
 */

/**
 * The one file allowed to contain the pattern: this one, which must name it to mean
 * anything. Mirrors the `ALLOW_LIST` carve-out in `no-env-secrets-access.js`.
 */
const EXCLUDED = [':(exclude)packages/config-eslint/rules/pnpm-run-args.test.js'];

/** Everywhere a command is documented: prose, docblocks, scripts, workflows. */
const PATHSPECS = [
  '*.md',
  '*.mdx',
  '*.ts',
  '*.tsx',
  '*.js',
  '*.mjs',
  '*.cjs',
  '*.yml',
  '*.yaml',
  '*.sh',
];

/**
 * `pnpm`, then anything up to a bare ` -- ` that is followed by a flag.
 *
 * The trailing `-` is what keeps `dotenv … -- tsx` out: it demands the token after
 * the separator be a flag rather than a command. `[^ ]` before the separator keeps
 * it anchored to a real argument list rather than an empty match.
 */
const PATTERN = [
  // (a) flags on the SAME line. ` +` rather than one literal space: `--   --project`
  //     is a real spelling and hid from the single-space version of this pattern.
  'pnpm .*[^ ] -- +-',
  // (b) flags on the NEXT line, behind a shell continuation. `git grep` is
  //     line-based, so ` -- \` shows no flag at all on the matched line — 24 of
  //     these were live when only (a) existed. A trailing backslash after ` -- `
  //     is never anything but a continuation, so matching the backslash is enough.
  //     ⚠️ No `$` anchor: git's ERE does not treat it reliably inside this use.
  'pnpm .*[^ ] -- +\\\\',
];

/**
 * `git grep` is line-based, so `.` is the right wildcard — never a newline class.
 * An array is ORed into one `git grep` invocation, so the two spellings cost one
 * spawn between them (see `lib/repo-scan.js` on why spawn count matters here).
 */
function scan(pattern, pathspecs = PATHSPECS) {
  return gitGrep({
    patterns: pattern,
    pathspecs: [...pathspecs, ...EXCLUDED],
    mode: 'extended',
    list: false,
  });
}

describe('a documented pnpm invocation carries no `--` separator', () => {
  // ------------------------------------------------------------------
  // 0. POSITIVE CONTROL. The real assertion expects an EMPTY result, and an empty
  //    result is exactly what a broken scan returns too — a typo'd pattern, a
  //    pathspec that matches nothing, an exclusion that swallows the tree. Prove
  //    the scanner reads the surface before trusting it to find nothing.
  // ------------------------------------------------------------------
  it('the scan actually reaches the documented invocations', () => {
    // The corrected form, which this repo now has ~40 of.
    expect(scan('pnpm --filter .* --project').length).toBeGreaterThan(0);
  });

  // ⚠️ The scan anchor above proves the SURFACE is read; it does not prove
  //    `PATTERN` still describes the defect, because it greps a different string.
  //    Replacing `PATTERN` with nonsense left every other test green until this
  //    case existed — the exact vacuity `lib/repo-scan.js` warns about, in the
  //    guard meant to prevent it. ERE and JS agree on patterns this simple.
  //
  // ⚠️ EVERY spelling gets a literal here, and that is not thoroughness for its
  //    own sake: the first version of this guard shipped with only (a), and a
  //    one-space assumption it SHARED with the sweep that preceded it — so the
  //    guard could not catch what the sweep had missed, and a green CI certified
  //    a tree with 25 live offenders in it. A spelling with no literal below is a
  //    spelling nothing is checking.
  it('every PATTERN spelling still recognises the defect', () => {
    const hits = (line) => PATTERN.some((p) => new RegExp(p).test(line));
    // (a) same line, one space — the original spelling.
    expect(hits('pnpm --filter @delfrance/migrations migrate:x -- --project <id>')).toBe(true);
    // Single-dash too: `test -- -u` is how the snapshot hints were broken, and a
    // pattern that only saw `-- --` would have missed both of them.
    expect(hits('pnpm --filter @delfrance/rules-gen test -- -u')).toBe(true);
    // (a') MORE than one space — `LIVE-TEST.md:247` was live behind exactly this.
    expect(hits('pnpm --filter @delfrance/mercado-livre-app probe:x --   --project <id>')).toBe(
      true,
    );
    // (b) shell continuation — 24 lines were live behind this one, six of them the
    //     sibling docblock of a README whose own copy had already been corrected.
    expect(hits('pnpm --filter @delfrance/migrations migrate:telefone-e164 -- \\')).toBe(true);

    expect(hits('pnpm --filter @delfrance/web dev')).toBe(false);
    expect(hits('dotenv -e ../../.env.local -- tsx scripts/x.ts')).toBe(false);
  });

  it('⛔ no `pnpm … -- --flag` anywhere — it dies on its own separator', () => {
    const offenders = scan(PATTERN);
    expect(
      offenders,
      `Drop the \` -- \`: pnpm forwards it into the script, which rejects it as an ` +
        `unknown argument.\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('does NOT flag the dotenv separator, which is correct and is everywhere', () => {
    // `dotenv -e ../../.env.local -- tsx scripts/x.ts` must survive: that `--`
    // belongs to dotenv-cli and the token after it is a COMMAND, not a flag.
    // Asserted against `*.json`, where those lines live; the first expectation is
    // what stops this passing vacuously if they ever move.
    expect(scan('dotenv -e .* -- tsx', ['*.json']).length).toBeGreaterThan(0);
    expect(scan(PATTERN, ['*.json'])).toEqual([]);
  });
});
