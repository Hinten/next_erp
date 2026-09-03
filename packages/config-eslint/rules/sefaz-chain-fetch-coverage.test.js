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
 * `--uf=` slots that suite reaches.
 *
 * `ufs` is what the job MUST fetch, not everything it may — a job fetching more
 * passes (`nfe-live` also pulls the SVC chains for its advisory step).
 */
const LIVE_JOBS = [
  {
    workflow: '.github/workflows/nfe-epec-scheduled.yml',
    job: 'epec-live',
    test: 'test epec.homologacao',
    // Both halves of the round-trip: the evento at the AN (`rt.an()`), then
    // the pós-EPEC transmission of the full NF-e to the home SEFAZ.
    ufs: ['AN', 'SP'],
    why: 'EPEC registers at the Ambiente Nacional and retransmits to the home SEFAZ (#1393)',
  },
  {
    workflow: '.github/workflows/nfe-epec-scheduled.yml',
    job: 'svc-live',
    test: 'test svc.homologacao',
    ufs: ['SVC-AN', 'SVC-RS'],
    why: 'SVC-AN native emission + SVC-RS off-binding transport',
  },
  {
    workflow: '.github/workflows/ci-nfe.yml',
    job: 'nfe-live',
    test: 'test orchestrator.homologacao',
    ufs: ['SP'],
    why: 'the per-PR live lane emits against the SP homologação endpoint',
  },
];

/**
 * The `--uf=` slots a job body actually fetches.
 *
 * Two invocation shapes are in use and both must be read:
 *
 *   - explicit — `ensure_chain <file> -- --uf=AN --ambiente=homologacao`, whose
 *     `--uf=` sits on the CALLER line while `fetch:sefaz-ca "$@"` sits inside
 *     the helper, so this scans the whole job body rather than per line;
 *   - bare — `pnpm ... fetch:sefaz-ca` with no `--uf=` at all, which
 *     `scripts/fetch-sefaz-chain.mjs` defaults to `SP` (`args.uf ?? 'SP'`).
 *     ⚠️ Reading that default here is what keeps `ci-nfe.yml`'s bare call
 *     honest instead of forcing a cosmetic rewrite of a working lane.
 *
 * Comments are stripped first: a `--uf=` named in prose is not a fetch, the
 * exact confusion `lib/workflow-scan.js`'s header documents.
 */
function fetchedSlots(jobBody) {
  const body = stripComments(jobBody);
  const slots = new Set();
  for (const m of body.matchAll(/--uf=([A-Za-z-]+)/g)) slots.add(m[1].toUpperCase());
  for (const line of body.split('\n')) {
    if (!line.includes('fetch:sefaz-ca')) continue;
    const after = line.slice(line.indexOf('fetch:sefaz-ca') + 'fetch:sefaz-ca'.length);
    // `"$@"` forwards the caller's flags; those were collected above.
    if (!after.includes('--uf=') && !after.includes('$@')) slots.add('SP');
  }
  return slots;
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
    const covered = new Set(LIVE_JOBS.flatMap((j) => j.ufs));
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

  it('fetches every chain its live suite reaches', () => {
    const gaps = LIVE_JOBS.flatMap(({ workflow, job, test, ufs, why }) => {
      const body = jobBlocks(read(workflow))[job] ?? '';
      const fetched = fetchedSlots(body);
      const missing = ufs.filter((u) => !fetched.has(u));
      if (missing.length === 0) return [];
      return [
        `${workflow} › ${job} runs \`${test}\` but never fetches: ${missing.join(', ')}`,
        `    (${why})`,
        `    fetched: ${[...fetched].sort().join(', ') || '(nothing)'}`,
        `    add: ensure_chain sefaz-${missing[0].toLowerCase()}-homologacao.pem --uf=${missing[0]} --ambiente=homologacao`,
      ];
    });

    expect(
      gaps,
      [
        'A live suite reaches a SEFAZ transport whose TLS chain its job never',
        'fetches. Nothing is vendored, so that chain is ENOENT at the first call',
        'and the job dies before reaching SEFAZ — exactly issue #1393:',
        '',
        ...gaps,
      ].join('\n'),
    ).toEqual([]);
  });
});
