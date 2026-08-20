import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #1150 — a component test renders through its workspace's `MantineTestProvider`,
 * never through a hand-written `<MantineProvider>`.
 *
 * The prop had drifted: 23 of 56 test files in `apps/web` and 5 of 14 in
 * `packages/ui` omitted `env="test"`, and nothing said which half was right —
 * the convention lived only in four ad-hoc comments. Worse, the drift HID the
 * real bug, because `env="test"` was widely believed to disable Mantine's
 * transition timer and does not: `Transition` calls `useTransition` *before* its
 * `env === 'test'` early return, so the timer fired after jsdom teardown and
 * reported `ReferenceError: window is not defined` from `Timeout._onTimeout`
 * with EVERY TEST GREEN. It cost #1025 and #1089 a full investigation each.
 *
 * The timer is neutralised in each `vitest.setup.ts`; `env="test"` only
 * normalises rendering (overlays inline instead of portalled, no `<Activity>`).
 * One provider factory per workspace makes both facts a single edit, not 70.
 *
 * Ask git rather than walking the filesystem, for the reason
 * `env-example-location.test.js` documents: a walk needs a skip-list, and the
 * directories it must skip (`node_modules`, `.old/`, `.deploy/`,
 * `.claude/worktrees`) are exactly the ones that produce false positives — a
 * worktree checkout holds a full second copy of every file scanned here.
 * `git ls-files` reports only the CURRENT worktree's index, and the `--others`
 * pass is load-bearing rather than belt-and-braces: a brand-new test file is
 * untracked, which is precisely when catching it is still cheap.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Only `*.test.ts(x)`. Scoping by FILENAME is what keeps this guard off
 * `apps/web/app/(app)/produtos/_components/mercado-livre/MercadoLivreTab.tsx` — a
 * PRODUCTION module whose JSDoc quotes the literal string `MantineProvider
 * env="test"` while explaining what the prop does to `<Activity>`, and which the
 * grep published in #1150 would have flagged — and off the two `mantine.tsx`
 * helpers, the one place allowed to build a provider. Do not widen this to every
 * `.tsx`; the exclusions would have to become a list.
 */
const TEST_MODULES = [
  'apps/web/**/*.test.ts',
  'apps/web/**/*.test.tsx',
  'packages/ui/src/**/*.test.ts',
  'packages/ui/src/**/*.test.tsx',
];

const WEB_PROBE = 'apps/web/lib/testing/mantine-transitions.test.tsx';
const UI_PROBE = 'packages/ui/src/testing/mantine-transitions.test.tsx';

/**
 * Carve-outs, each of which must state WHY the bare provider is load-bearing.
 * This list only shrinks.
 *
 * - The two #1150 mechanism probes: under `env="test"` `Transition` short-circuits
 *   to `children({})` whichever branch `useTransition` took, so their assertion
 *   would pass vacuously.
 * - `SectionTabs.persistence.test.tsx`: `env="test"` makes Mantine skip
 *   `<Activity>` entirely (`TabsPanel.mjs:19`), and an inactive panel having its
 *   effects torn down and re-run is precisely what that file pins. Every OTHER
 *   SectionTabs test keeps the helper.
 *
 * Note these files are still protected from the leaked timer: the lever is
 * `DEFAULT_THEME.respectReducedMotion` in `vitest.setup.ts`, which applies to a
 * bare provider too. That is the whole reason the fix is not `env="test"`.
 */
const ALLOWED_BARE_PROVIDER = new Set([
  WEB_PROBE,
  UI_PROBE,
  'packages/ui/src/object/SectionTabs.persistence.test.tsx',
]);

/**
 * Two spellings, because either alone leaves a hole: the IMPORT (which an
 * `as`-rename or a multi-line specifier list would otherwise dodge — `[^;]` also
 * matches newlines) and the JSX OPENING TAG (a provider reached through some
 * other binding). `\b` keeps it off `HeadlessMantineProvider`, which has no word
 * boundary before its `M`; `MantineThemeProvider` and `MantineTestProvider` are
 * different tokens; a prose mention in a comment matches neither alternative.
 *
 * Known, accepted hole: a namespace import plus `m.MantineProvider`. Not a
 * plausible accident, and the JSX alternative still catches the render.
 */
const BUILDS_BARE_PROVIDER =
  /(?:^|\n)\s*import\b[^;]*?\bMantineProvider\b[^;]*?from\s*['"]@mantine\/core['"]|<MantineProvider[\s/>]/;

function gitList(args) {
  return execFileSync('git', [...args, '--', ...TEST_MODULES], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

function testModules() {
  const tracked = gitList(['ls-files']);
  const untracked = gitList(['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...tracked, ...untracked])].sort();
}

const read = (relativePath) => readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');

describe('MantineProvider is built only by the test helper (#1150)', () => {
  const modules = testModules();

  // A meta-test that scans nothing passes vacuously — the exact failure mode
  // this file exists to prevent. 233 tracked + 2 untracked today.
  it('finds the test modules it is supposed to police', () => {
    expect(modules.length).toBeGreaterThan(200);
  });

  // Anchors the CONTENT read, not just the filename list: a broken `read()` or a
  // wrong REPO_ROOT would leave every file looking clean.
  it('and actually reads them — the helper is in real use', () => {
    const usingHelper = modules.filter((file) => /\bMantineTestProvider\b/.test(read(file)));
    expect(usingHelper.length).toBeGreaterThan(60); // 70 today
  });

  it('no test module constructs a MantineProvider itself', () => {
    const offenders = modules
      .filter((file) => !ALLOWED_BARE_PROVIDER.has(file))
      .filter((file) => BUILDS_BARE_PROVIDER.test(read(file)));

    expect(
      offenders,
      [
        'These test modules build their own <MantineProvider>. Render through the',
        'workspace MantineTestProvider instead — `@/lib/testing/mantine` in apps/web,',
        '`../testing/mantine` in packages/ui:',
        '',
        ...offenders.map((file) => `  - ${file}`),
        '',
        'A hand-written provider is how `env="test"` ended up on 33 of 56 apps/web test',
        'files and off the other 23 (#1150) — and how the belief that the prop stopped',
        'the leaked transition timer survived, when the actual lever is',
        'DEFAULT_THEME.respectReducedMotion in vitest.setup.ts.',
        '',
        'If a test genuinely needs the bare provider — the transition probes do, because',
        'env="test" would make their assertion vacuous — add it to ALLOWED_BARE_PROVIDER',
        'above WITH the reason.',
      ].join('\n'),
    ).toEqual([]);
  });

  // This fix ships the same convention twice (one setup file and one probe per
  // workspace), and #1150 IS a drift bug. Each probe pins its OWN vitest.setup.ts,
  // so they must stay identical; splitting them should be a decision, not an
  // accident — delete this test in the same change that splits them.
  it('the two transition probes have not diverged', () => {
    expect(read(WEB_PROBE), `${WEB_PROBE} and ${UI_PROBE} must stay identical`).toBe(
      read(UI_PROBE),
    );
  });

  // An entry left behind for a deleted file silently re-allows a bare provider at
  // that path forever.
  it('the carve-out list only shrinks: every entry still exists', () => {
    const present = new Set(modules);
    const stale = [...ALLOWED_BARE_PROVIDER].filter((file) => !present.has(file));
    expect(stale, `Remove deleted entries from ALLOWED_BARE_PROVIDER: ${stale.join(', ')}`).toEqual(
      [],
    );
  });

  // A synthetic positive control, per ci-lane-gates.test.js: a scanner nobody
  // proved can fail is a scanner nobody should trust.
  it('bites — the matcher catches each spelling and trips on no near miss', () => {
    const bites = (source) => BUILDS_BARE_PROVIDER.test(source);
    expect(bites("import { MantineProvider } from '@mantine/core';")).toBe(true);
    expect(bites("import { MantineProvider as MP } from '@mantine/core';")).toBe(true);
    expect(bites("import {\n  Badge,\n  MantineProvider,\n} from '@mantine/core';")).toBe(true);
    expect(bites('  return <MantineProvider env="test">{children}</MantineProvider>;')).toBe(true);
    expect(bites('    <MantineProvider>')).toBe(true);

    expect(bites("import { HeadlessMantineProvider } from '@mantine/core';")).toBe(false);
    expect(bites("import { MantineThemeProvider } from '@mantine/core';")).toBe(false);
    expect(bites("import { MantineTestProvider } from '@/lib/testing/mantine';")).toBe(false);
    expect(bites('<MantineTestProvider>')).toBe(false);
    expect(bites('// MantineProvider injects a <style> tag into the same container')).toBe(false);
  });
});
