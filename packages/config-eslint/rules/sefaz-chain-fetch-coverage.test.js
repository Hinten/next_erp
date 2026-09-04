import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, gitLsFiles } from './lib/repo-scan.js';
import { jobBlocks, stripComments } from './lib/workflow-scan.js';

/**
 * Repo invariant: every SEFAZ TLS chain slot the NF-e runtime can load is
 * FETCHED by the CI job that runs the live suite reaching it.
 *
 * ## Why this exists
 *
 * `packages/integrations/nfe/ca/` tracks exactly one file — its own
 * `.gitignore`, which ignores every `sefaz-*.pem`. So a chain is on a runner's
 * disk only if that job's `fetch:sefaz-ca` put it there (or a cache restored a
 * previous run's fetch). A slot no job fetches is not "degraded": it is ENOENT
 * at the first call, thrown by `runtime.ts:loadChain` before a byte reaches
 * SEFAZ.
 *
 * ⚠️ And that failure is INVISIBLE until the job runs, because the contingency
 * transports are **lazy**: `rt.svc()` and `rt.an()` read their chain on first
 * use, so the process boots, `/api/health` is green, every unit test passes,
 * and only the live round-trip discovers the gap.
 *
 * Not hypothetical. `nfe-epec-scheduled.yml`'s `epec-live` job fetched the SP
 * chain alone, on the strength of a comment asserting the Ambiente Nacional
 * endpoint "rides the vendored DFe root, no per-run fetch". No such file is or
 * ever was checked in. EPEC registers its evento at the AN through `rt.an()`,
 * which reads `ca/sefaz-an-<ambiente>.pem` — so the job died on ENOENT in 7
 * seconds on its **first-ever** scheduled run (issue #1393), and because that
 * cron is MONTHLY the lane had never been green and nothing in the repo said
 * so. The comment was the only thing standing where this assertion belongs.
 *
 * ## Why a test rather than a lint rule
 *
 * The invariant spans TypeScript and workflow YAML, and ESLint never sees the
 * YAML. Failing this test fails CI exactly like a lint error would.
 *
 * ⚠️ Not a YAML parse, deliberately — same reason `ci-lane-gates.test.js` and
 * `functions-region-supplied.test.js` give: `on:` is a YAML 1.1 boolean, so a
 * naive parse keys that block as `true` and a guard reading it passes
 * vacuously over every file.
 */

/** Where the chain slots are declared and read. */
const RUNTIME_FILE = 'apps/nfe/lib/nfe/runtime.ts';

/** The `ca/` directory whose emptiness is this guard's whole premise. */
const CA_DIR = 'packages/integrations/nfe/ca';

/**
 * ⚠️ Normalize line endings. `core.autocrlf=true` checks these files out as
 * CRLF on Windows while CI sees LF, and every scan below is line-oriented.
 */
const read = (file) => readFileSync(resolve(REPO_ROOT, file), 'utf8').split('\r\n').join('\n');

/**
 * Every `loadChainCached(<slot>, ambiente)` call site in `runtime.ts`, keyed by
 * the argument expression as it appears in source, with the `--uf=` values that
 * expression can resolve to.
 *
 * ⚠️ This is an INVENTORY, not a filter. A new transport (a fourth authorizer,
 * a second national environment) adds a call site, the first assertion below
 * reds because the discovered set no longer matches, and adding the row here
 * then forces a `LIVE_JOBS` row that actually fetches it. That two-step is the
 * point: neither half can be satisfied by editing this file alone.
 *
 * `uf` is the filial's own UF — 27 possible values in production, but the live
 * lanes all emit for the SP test filial, so SP is the only one CI must hold.
 */
const CHAIN_CALL_SITES = {
  uf: { slots: ['SP'], what: 'home SEFAZ (the filial UF; SP for every live lane)' },
  authorizer: { slots: ['SVC-AN', 'SVC-RS'], what: 'SVC contingency authorizers (rt.svc())' },
  "'an'": { slots: ['AN'], what: 'Ambiente Nacional — the EPEC evento drop-box (rt.an())' },
};

/**
 * Every workflow job that runs a live SEFAZ suite: the suite's command, and the
 * chains that suite reaches as `<UF>:<ambiente>` pairs.
 *
 * ⚠️ The AMBIENTE is half the identity, not decoration. `runtime.ts` resolves
 * `sefaz-<uf>-<ambiente>.pem`, so a job that fetches `--uf=AN --ambiente=producao`
 * has fetched a real chain and still leaves `sefaz-an-homologacao.pem` absent —
 * the job passes its fetch step and ENOENTs inside the test. Pairing them here
 * is what makes that a red guard instead of a live-lane surprise.
 *
 * `chains` is what the job MUST fetch, not everything it may — a job fetching
 * more passes (`nfe-live` also pulls the SVC chains for its advisory step).
 *
 * ⚠️ Model limit, deliberate: ONE suite per row. A job running several live
 * suites is covered only for the one named here, so a NEW suite added to an
 * EXISTING job inherits that row's chains rather than declaring its own. No gap
 * today — `operations` and `rtc` both run in `nfe-live`, whose SP row already
 * covers them — but a new suite reaching a NEW transport from an existing job
 * would slip through. Add a row for it.
 */
/**
 * Every workflow that defines an `ensure_chain()` helper — DISCOVERED, never
 * listed.
 *
 * ⚠️ A hardcoded list would defeat the point. The shape assertion below is what
 * makes N inline copies of the helper safe, and it can only do that for copies
 * it can SEE: with a two-file allowlist, a FOURTH copy pasted into a new lane
 * is back to being kept honest by discipline — the exact thing this guard
 * replaces. Same "discover, don't enumerate" rule `functions-region-supplied`
 * and `runtime-deps-pinned` follow.
 *
 * Untracked files count (`gitLsFiles` default), so a new workflow is covered
 * before it is committed.
 */
function workflowsDefiningEnsureChain() {
  return gitLsFiles(':(glob).github/workflows/*.y*ml').filter((wf) =>
    HELPER_DEFINITION.test(read(wf)),
  );
}

/** ⚠️ Stateless: `RegExp#test` with `/g` would advance `lastIndex` across calls. */
const HELPER_DEFINITION = /ensure_chain\(\)\s*\{/;

/**
 * One `ensure_chain()` definition: group 1 is its indent, group 2 its body.
 *
 * ⚠️ The closing brace is anchored by BACKREFERENCE to the opening line's
 * indent, not at a fixed column. It used to be `\n {10}\}` — exactly ten
 * spaces — which is right for a `run:` block today and silently wrong the
 * moment anything reindents the file: the scan yields ZERO blocks, `offenders`
 * comes back empty, and the shape assertion passes over no helpers at all.
 * Measured: reindenting `nfe-epec-scheduled.yml` by two spaces took the old
 * pattern from 2 matches to 0 while every assertion stayed green.
 *
 * `matchAll` clones the regex, so sharing this `/g` instance is safe.
 */
const HELPER_BLOCK = /^([ \t]*)ensure_chain\(\)\s*\{\n([\s\S]*?)\n\1\}/gm;

/**
 * The copies that exist today — an anti-vacuity FLOOR under the discovery
 * above, not its input. Renaming the helper (or a pathspec that stops matching)
 * empties the discovery, and an empty list passes every scan silently; this is
 * what turns that into a red.
 */
const KNOWN_HELPER_WORKFLOWS = [
  '.github/workflows/ci-nfe.yml',
  '.github/workflows/nfe-epec-scheduled.yml',
];

const LIVE_JOBS = [
  {
    workflow: '.github/workflows/nfe-epec-scheduled.yml',
    job: 'epec-live',
    test: 'test epec.homologacao',
    // Both halves of the round-trip: the evento at the AN (`rt.an()`), then
    // the pós-EPEC transmission of the full NF-e to the home SEFAZ.
    chains: ['AN:homologacao', 'SP:homologacao'],
    why: 'EPEC registers at the Ambiente Nacional and retransmits to the home SEFAZ (#1393)',
  },
  {
    workflow: '.github/workflows/nfe-epec-scheduled.yml',
    job: 'svc-live',
    test: 'test svc.homologacao',
    chains: ['SVC-AN:homologacao', 'SVC-RS:homologacao'],
    why: 'SVC-AN native emission + SVC-RS off-binding transport',
  },
  {
    workflow: '.github/workflows/ci-nfe.yml',
    job: 'nfe-live',
    test: 'test orchestrator.homologacao',
    chains: ['SP:homologacao'],
    why: 'the per-PR live lane emits against the SP homologação endpoint',
  },
];

/**
 * Resolve the two shell variables a fetch step may assign, so `--uf="$uf"`
 * reads as `--uf=SP`.
 *
 * ⚠️ Deliberately narrow — only bare `uf=`/`ambiente=` assignments, nothing
 * else. `ci-nfe.yml`'s SP step assigns them precisely so its fetch flags and
 * its cache-probe path derive from ONE value; a guard that could not follow
 * that indirection would read no slot there at all and pass vacuously over
 * the step it most needs to check.
 */
function resolveShellVars(body) {
  const vars = new Map();
  for (const m of body.matchAll(/(?:^|\s|;)(uf|ambiente)=([A-Za-z0-9_-]+)\s*(?=;|$)/gm)) {
    vars.set(m[1], m[2]);
  }
  return body.replace(
    /"\$(uf|ambiente)"|\$\{(uf|ambiente)\}|\$(uf|ambiente)\b/g,
    (whole, a, b, c) => {
      const name = a ?? b ?? c;
      return vars.get(name) ?? whole;
    },
  );
}

/**
 * The `<UF>:<ambiente>` chains a job body actually fetches.
 *
 * Paired PER LINE, because every call site now carries both flags together:
 * `ensure_chain --uf=AN --ambiente=homologacao`, whose flags sit on the CALLER
 * line while `fetch:sefaz-ca "$@"` sits inside the helper. Collecting the two
 * flags independently across the body would happily pair an `AN` from one line
 * with a `homologacao` from another.
 *
 * Comments are stripped first: a `--uf=` named in prose is not a fetch, the
 * exact confusion `lib/workflow-scan.js`'s header documents.
 */
function fetchedChains(jobBody) {
  const body = resolveShellVars(stripComments(jobBody));
  const chains = new Set();
  for (const line of body.split('\n')) {
    const uf = line.match(/--uf=([A-Za-z-]+)/);
    const ambiente = line.match(/--ambiente=([A-Za-z-]+)/);
    if (uf && ambiente) chains.add(`${uf[1].toUpperCase()}:${ambiente[1]}`);
  }
  return chains;
}

/**
 * Lines invoking the fetcher without saying which chain they want.
 *
 * `scripts/fetch-sefaz-chain.mjs` defaults to `SP`/`homologacao`, and leaning on
 * those defaults is how a step ends up fetching one chain while probing for
 * another. A line is fine when it forwards `"$@"` (the helper's own invocation,
 * whose flags come from its caller) or when it names both flags itself.
 *
 * ⚠️ Scoped to lines that actually run `pnpm`. Each helper echoes
 * `fetch:sefaz-ca $*` in its retry and fallback diagnostics; naming the script
 * is not running it.
 */
function flaglessFetches(jobBody) {
  const body = resolveShellVars(stripComments(jobBody));
  return body
    .split('\n')
    .filter((line) => {
      const at = line.indexOf('fetch:sefaz-ca');
      if (at === -1) return false;
      // ⚠️ Only an INVOCATION counts. Every helper echoes `fetch:sefaz-ca $*`
      // in its retry and fallback diagnostics, and those name the script
      // without running it — the qualifier that keeps this off five innocent
      // lines per workflow, the same shape `no-unvalidated-response` uses.
      if (!/\bpnpm\b/.test(line.slice(0, at))) return false;
      const after = line.slice(at + 'fetch:sefaz-ca'.length);
      if (after.includes('$@')) return false;
      return !(after.includes('--uf=') && after.includes('--ambiente='));
    })
    .map((line) => line.trim());
}

/**
 * `ensure_chain()` definitions that do NOT derive their cache-probe path from
 * their own flags.
 *
 * ⚠️ This is the assertion that makes three inline copies of the helper safe.
 * The original took the filename as `$1` and forwarded the flags separately, so
 * the probe and the fetch were independent sources of truth:
 * `ensure_chain sefaz-an-homologacao.pem --uf=AN --ambiente=producao` fetched
 * successfully, wrote `sefaz-an-producao.pem`, returned 0 on the first attempt
 * without ever reaching the `-f` probe, and the job then ENOENTed inside the
 * test. Worse in `ci-nfe.yml`, whose copy reads the probe path BEFORE fetching
 * to decide whether to fetch at all — a mismatch there skips the fetch on the
 * strength of the wrong file.
 *
 * The helper is duplicated per job on purpose rather than extracted to
 * `.github/scripts/`: workflow YAML comes from the merge ref while the checkout
 * comes from the PR head (root `CLAUDE.md` rule 5), and a chain fetch has no
 * safe degraded verdict. This guard is what keeps the copies from drifting.
 */
function helpersNotDerivingTheirPath(source) {
  const offenders = [];
  for (const m of source.matchAll(HELPER_BLOCK)) {
    // ⚠️ Comments first. This helper's own docblock NAMES the `$1` shape it
    // exists to ban, and a mention is not a use — the same confusion
    // `lib/workflow-scan.js`'s header documents for job bodies.
    const body = stripComments(m[2]);
    const derives =
      /local file="packages\/integrations\/nfe\/ca\/sefaz-\$\{uf,,\}-\$\{ambiente\}\.pem"/.test(
        body,
      );
    const positional = /\$\{?1\}?/.test(body);
    if (!derives || positional) {
      offenders.push(
        positional ? 'takes the filename as a positional ($1)' : 'does not derive its probe path',
      );
    }
  }
  return offenders;
}

/** `loadChainCached(<arg>, …)` call sites, excluding the function's own declaration. */
function chainCallSites(source) {
  const args = new Set();
  for (const m of source.matchAll(/(function\s+)?loadChainCached\(\s*([^,)]+?)\s*[,)]/g)) {
    if (m[1]) continue;
    args.add(m[2]);
  }
  return args;
}

describe('every SEFAZ chain slot the runtime loads is fetched by its live lane', () => {
  it('nothing is vendored — the premise still holds', () => {
    // ⚠️ The whole guard rests on this. If chains were ever committed, a
    // missing fetch would stop being fatal and these assertions would be
    // enforcing a rule that no longer means anything.
    const tracked = gitLsFiles(`${CA_DIR}/*.pem`, { includeUntracked: false });
    expect(
      tracked,
      [
        `${CA_DIR}/ now tracks .pem files, so a chain no longer has to be fetched`,
        'per run. Re-read this guard before deleting it: the reason it exists is',
        'that an unfetched slot is ENOENT, and that is no longer true for these:',
        ...tracked.map((p) => `  - ${p}`),
      ].join('\n'),
    ).toEqual([]);

    expect(
      read(`${CA_DIR}/.gitignore`),
      `${CA_DIR}/.gitignore no longer ignores sefaz-*.pem — see the message above.`,
    ).toContain('sefaz-*.pem');
  });

  it('inventories every chain slot the runtime can load', () => {
    const found = chainCallSites(read(RUNTIME_FILE));
    const known = new Set(Object.keys(CHAIN_CALL_SITES));

    const added = [...found].filter((a) => !known.has(a));
    const gone = [...known].filter((a) => !found.has(a));

    expect(
      { added, gone },
      [
        `The \`loadChainCached(...)\` call sites in ${RUNTIME_FILE} no longer match`,
        "this guard's inventory.",
        '',
        ...(added.length
          ? [
              `  NEW slot(s): ${added.join(', ')}`,
              '  A new transport needs a CHAIN_CALL_SITES row naming its `--uf=` value',
              '  AND a LIVE_JOBS row whose job actually fetches it — a slot nothing',
              '  fetches is ENOENT on the first live call, not a degraded mode.',
            ]
          : []),
        ...(gone.length
          ? [`  GONE: ${gone.join(', ')} — drop the row, and its slots from LIVE_JOBS.`]
          : []),
      ].join('\n'),
    ).toEqual({ added: [], gone: [] });
  });

  it('covers every inventoried slot with at least one live job', () => {
    const covered = new Set(LIVE_JOBS.flatMap((j) => j.chains.map((c) => c.split(':')[0])));
    const uncovered = Object.entries(CHAIN_CALL_SITES).flatMap(([site, { slots, what }]) =>
      slots.filter((s) => !covered.has(s)).map((s) => `${s} (${site} — ${what})`),
    );

    expect(
      uncovered,
      [
        'These chain slots are declared in CHAIN_CALL_SITES but no LIVE_JOBS row',
        'requires them, so nothing below checks that any job fetches them:',
        ...uncovered.map((s) => `  - ${s}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('still finds every inventoried job, and its live suite in it', () => {
    // ⚠️ Anti-vacuity floor. Without it, a renamed job or a moved test command
    // makes the coverage assertion skip that row and pass having checked
    // nothing — which is how the defect this guard exists for stayed hidden.
    const broken = LIVE_JOBS.flatMap(({ workflow, job, test }) => {
      const body = jobBlocks(read(workflow))[job];
      if (body === undefined) return [`${workflow} › job \`${job}\` not found`];
      if (!body.trim()) return [`${workflow} › job \`${job}\` parsed EMPTY`];
      if (!stripComments(body).includes(test)) {
        return [`${workflow} › job \`${job}\` no longer runs \`${test}\``];
      }
      return [];
    });

    expect(
      broken,
      [
        'The inventory drifted from the workflows, so the coverage assertion',
        'below would examine nothing for these rows:',
        ...broken.map((b) => `  - ${b}`),
        '',
        'Either the job/suite moved (update LIVE_JOBS) or lib/workflow-scan.js',
        'stopped parsing this shape.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('fetches every chain its live suite reaches, at the right ambiente', () => {
    const gaps = LIVE_JOBS.flatMap(({ workflow, job, test, chains, why }) => {
      const body = jobBlocks(read(workflow))[job] ?? '';
      const fetched = fetchedChains(body);
      const missing = chains.filter((c) => !fetched.has(c));
      if (missing.length === 0) return [];
      const [uf, ambiente] = missing[0].split(':');
      return [
        `${workflow} › ${job} runs \`${test}\` but never fetches: ${missing.join(', ')}`,
        `    (${why})`,
        `    fetched: ${[...fetched].sort().join(', ') || '(nothing)'}`,
        `    add: ensure_chain --uf=${uf} --ambiente=${ambiente}`,
      ];
    });

    expect(
      gaps,
      [
        'A live suite reaches a SEFAZ transport whose TLS chain its job never',
        'fetches at the ambiente it needs. Nothing is vendored, so that chain is',
        'ENOENT at the first call and the job dies before reaching SEFAZ —',
        'exactly issue #1393:',
        '',
        ...gaps,
      ].join('\n'),
    ).toEqual([]);
  });

  it('every ensure_chain derives its probe path from its own flags', () => {
    // ⚠️ The finding this guard grew for. A helper taking the filename
    // alongside the flags lets the two disagree silently — see
    // `helpersNotDerivingTheirPath`'s note for the exact failure.
    const offenders = workflowsDefiningEnsureChain().flatMap((wf) =>
      helpersNotDerivingTheirPath(read(wf)).map((why) => `${wf}: ${why}`),
    );

    expect(
      offenders,
      [
        'An `ensure_chain()` definition no longer derives its cache-probe path',
        'from the same `--uf=`/`--ambiente=` flags it forwards to the fetcher,',
        'so the probe and the fetch can name different files:',
        '',
        ...offenders.map((o) => `  - ${o}`),
        '',
        'The body must open by parsing its own flags and building',
        '`packages/integrations/nfe/ca/sefaz-${uf,,}-${ambiente}.pem`.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('discovers at least the helper copies known to exist', () => {
    // Anti-vacuity floor under the discovery: a renamed helper, a pathspec that
    // stopped matching, or a broken definition regex all EMPTY the list rather
    // than failing, and the shape assertion above would then pass having
    // examined nothing.
    const found = workflowsDefiningEnsureChain();
    const missing = KNOWN_HELPER_WORKFLOWS.filter((wf) => !found.includes(wf));

    expect(
      missing,
      [
        'These workflows are known to define `ensure_chain()` and the discovery',
        'no longer finds them, so the shape assertion above examines less than it',
        'should — possibly nothing:',
        ...missing.map((wf) => `  - ${wf}`),
        '',
        `discovered: ${found.join(', ') || '(nothing)'}`,
        '',
        'Either the helper was renamed (update KNOWN_HELPER_WORKFLOWS and',
        '`HELPER_DEFINITION` together) or the git pathspec stopped matching.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('parses every helper it discovered — no block goes unexamined', () => {
    // ⚠️ Presence is not parsing, and the gap between them is silent. The floor
    // above proves a workflow still SAYS `ensure_chain() {`; only this proves
    // the block scan actually reached it. A definition whose brace anchor
    // drifts — or one sibling in a file whose other helper still matches —
    // leaves the shape assertion examining fewer helpers than exist, and an
    // empty `offenders` reads exactly like a clean bill of health.
    const unparsed = workflowsDefiningEnsureChain().flatMap((wf) => {
      const source = read(wf);
      const declared = (source.match(/ensure_chain\(\)\s*\{/g) ?? []).length;
      const parsed = [...source.matchAll(HELPER_BLOCK)].length;
      return declared === parsed ? [] : [`${wf}: ${declared} declared, ${parsed} parsed`];
    });

    expect(
      unparsed,
      [
        '`HELPER_BLOCK` matched fewer `ensure_chain()` definitions than these',
        'files declare, so the shape assertion skipped the difference in silence:',
        '',
        ...unparsed.map((u) => `  - ${u}`),
        '',
        "The block regex derives the closing brace from the opening line's",
        'indent; a definition it cannot parse is one it cannot check.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('no fetch:sefaz-ca leans on the script defaults', () => {
    // `fetch-sefaz-chain.mjs` defaults to SP/homologacao. A call that says
    // neither is a call whose chain identity lives nowhere in the workflow.
    const bare = LIVE_JOBS.flatMap(({ workflow, job }) => {
      const body = jobBlocks(read(workflow))[job] ?? '';
      return flaglessFetches(body).map((line) => `${workflow} › ${job}: ${line}`);
    });

    expect(
      bare,
      [
        'These invoke the chain fetcher without naming both `--uf=` and',
        "`--ambiente=`, so which chain lands on disk depends on the script's",
        'defaults rather than on anything the workflow says:',
        '',
        ...bare.map((b) => `  - ${b}`),
      ].join('\n'),
    ).toEqual([]);
  });
});
