---
name: impl-verify
description: >-
  Run a well-scoped implementation slice as a multi-agent Workflow: lock
  contracts, fan out implementation agents with disjoint file ownership, then
  adversarially verify with independent high-effort reviewers, gate
  sequentially, and ship a draft PR. Use when the user says: /impl-verify,
  "run the implement-verify workflow", "build this slice with the workflow",
  "fan-out implement + adversarial verify", "ultracode this slice", or asks to
  build a multi-file feature/port "the way the ML import slices were built".
  Not for trivial edits, pure research, or single-file changes.
---

# impl-verify — implement → adversarially verify → gate → ship

The delivery pattern that built the Mercado Livre import slices (#442, #520,
#521, #441): each PR is produced by a **Workflow** orchestration — parallel
implementation agents coding against **locked contracts**, then independent
**adversarial verifiers**, then the main loop triages findings, runs the gates
sequentially, and ships a draft PR. Invoking this skill is the user's explicit
opt-in to multi-agent orchestration (the Workflow tool).

**Input** (`args` or the surrounding conversation): the slice to build —
ideally an issue number plus any approved plan/deviations. If there is no
agreed plan yet, STOP and present one first (plan approval is the checkpoint;
this skill starts at "approved, build it").

## The five phases

### 0. Contract-locking (main loop, BEFORE launching anything)

This phase is what makes the fan-out cheap and correct. Do it yourself:

- Read the key files and pin **exact contracts**: function signatures, type
  shapes, deterministic id formulas (quote them character-exact), wire-shape
  rules, file paths. Every implementation agent codes against these verbatim.
- A formula that must stay identical in two files (e.g. a dedup key) is quoted
  byte-exact in the shared context with "must stay identical to X or Y breaks".
- Anything you could NOT verify yourself becomes an explicit agent instruction:
  "FIRST verify <thing> in <file> before coding — record what you found in
  notes". Never let an agent (or yourself) guess a wire shape or legacy
  behavior it could read.
- Decide file ownership: **each file belongs to exactly one agent**. Agents
  reference sibling agents' new files by contract, never create or edit them
  ("a concurrent agent owns that file — code against the signature").
- Branch fresh off updated `origin/main`; the worktree needs its own
  `pnpm install` when the lockfile moved.

### 1. Implement fan-out (Workflow phase)

2–4 agents in parallel. Model ladder: **Haiku** for mechanical plumbing
(barrels, option/flag threading, checkboxes), **Sonnet** for implementation +
tests, the main model only for extremely complex cross-cutting pieces. Every
prompt gets the shared CTX block (template below) containing:

- the WORKTREE absolute path ("edit HERE") — agents otherwise edit the main
  checkout; anything that only exists in the main checkout (e.g. a gitignored
  legacy reference copy) gets its own absolute path;
- the repo's hard rules (no generic catch, no `undefined` to Firestore, one
  timestamp per operation, style parity — whatever applies);
- the verified facts + locked contracts + approved deviations;
- **"DO NOT run pnpm/turbo/vitest/tsc"** — parallel package-manager runs
  thrash Windows; the main loop gates sequentially afterward;
- a structured return schema: `{ filesChanged, notes }` where `notes` carries
  verified facts, contract deviations, and uncertainties for the verifiers.

### 2. Adversarial verify (Workflow phase, after a `parallel()` barrier)

2–4 **Opus** agents, `effort: 'high'`, READ-ONLY (no edits, no build/test
commands). Each gets a **distinct lens** — diversity catches what redundancy
can't. Typical lenses:

- domain invariants (data/wire correctness, id determinism, "can X ever be
  overwritten?");
- error semantics + control flow (catch narrowing, retry/idempotency, write
  ordering, partial-failure recovery);
- parity vs a reference implementation (read the reference THEMSELVES,
  line-by-line — list the approved deviations so they aren't re-reported);
- tests/types/completeness (do tests assert real invariants or tautologies?
  do the agents' seams actually compile together? anything silently touched?).

Rules in every verifier prompt: start from `git diff origin/main`, then read
the full files; **quote proof or drop the finding**; empty findings is a valid
outcome. Findings schema: `{ file, line, severity: blocker|major|minor, claim,
evidence, fix }`.

### 3. Triage + fix (main loop)

- Findings land in the workflow result; if truncated, extract from
  `<transcriptDir>/journal.jsonl` (one `{"type":"result",...}` line per agent).
- Triage **honestly**: fix the real ones (same branch, small commits), reject
  the wrong ones with reasoning you'd defend in review. Convergent findings
  (multiple verifiers, same defect) are almost always real.
- **Zero findings ≠ done.** Review the diff yourself before gating — the
  verifiers replace neither the gates nor your own read.

### 4. Gate + ship (main loop, sequential — never parallel pnpm/turbo)

1. Targeted tests first (`node_modules/.bin/vitest run` per touched package),
   then `pnpm turbo run typecheck` (the acceptance gate), then lint.
2. `prettier --write` YOUR touched files only.
3. Commit (repo commit conventions), push, **draft PR** whose body ends with
   `Closes #NNN`.
4. `gh pr checks <pr> --watch` in the background; verify `mergeable` /
   `mergeStateStatus` (a main conflict silently blocks CI). On red: pull the
   failing log, distinguish a real regression from a known-flaky lane before
   re-running.
5. Mark ready-for-review when green. **Monitoring includes code reviews**: keep
   checking `gh api repos/<o>/<r>/pulls/<n>/comments`; triage each finding
   (fix or push back with reasoning), fix in the SAME PR, reply pointing at the
   fix commit, re-watch CI.

## Workflow script template

Adapt the placeholders; keep the structure. Scripts are plain JS (no TS
annotations) and must not call `Date.now()`/`Math.random()` (resume safety).

```js
export const meta = {
  name: '<slug>',
  description: 'Implement + adversarially verify <slice>',
  phases: [
    { title: 'Implement', detail: '<agent split>' },
    { title: 'Verify', detail: '<N> Opus refuters: <lenses>', model: 'opus' },
  ],
}

const CTX = `# Shared context — <slice>
WORKTREE (edit HERE, absolute): <path>
<other absolute paths agents need, e.g. a reference copy>
DO NOT run pnpm/turbo/vitest/tsc — the orchestrator gates afterward. Only read/write files.

## Hard repo rules
<the ones that apply>

## Verified facts (file:line — trust these; re-verify only where told)
<facts>

## Approved deviations (do NOT re-report)
<deviations>

## Cross-agent contracts (code EXACTLY against these)
<contracts — exact signatures, id formulas, wire shapes, per agent>`

phase('Implement')
const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    filesChanged: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'verified facts, deviations, uncertainties for verifiers' },
  },
  required: ['filesChanged', 'notes'],
}

const impl = await parallel([
  () => agent(CTX + `\n# YOUR TASK (A1 — <scope>)\n<task + owned files + "FIRST verify ..." steps>`,
    { label: 'impl:<a1>', phase: 'Implement', model: 'sonnet', schema: RESULT_SCHEMA }),
  // A2..An — disjoint file ownership; 'haiku' for mechanical-only agents
])

log('Implement done: ' + impl.filter(Boolean).flatMap((r) => r.filesChanged).length + ' files')

phase('Verify')
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' }, line: { type: 'number' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          claim: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' },
        },
        required: ['file', 'severity', 'claim', 'evidence', 'fix'],
      },
    },
  },
  required: ['findings'],
}

const VCTX = CTX + `\n# YOUR ROLE: adversarial verifier (READ-ONLY; no edits, no build/test commands)
git diff origin/main for the surface, then READ the full touched files. Refute with quoted
proof only; drop anything that does not survive re-reading. Empty findings is valid.
Cross-check the implementation agents' seams (imports/exports/signatures).`

const verdicts = await parallel([
  () => agent(VCTX + `\n# LENS 1 — <invariants lens>`,
    { label: 'verify:<l1>', phase: 'Verify', model: 'opus', effort: 'high', schema: FINDINGS_SCHEMA }),
  // LENS 2..N
])

const all = verdicts.filter(Boolean).flatMap((v) => v.findings)
log('Verify: ' + all.length + ' findings (' + all.filter((f) => f.severity === 'blocker').length + ' blockers)')
return { implement: impl.filter(Boolean), findings: all }
```

## Why this shape (the trade-offs it encodes)

- **Contracts up front** beat coordination during: parallel agents never talk
  to each other, so anything shared must be pinned before launch. The one time
  two agents each derived a shared formula independently, an empty-string edge
  diverged — hence "byte-exact or reference the owner".
- **`parallel()` barrier between implement and verify** is genuinely required
  (verifiers need the finished diff) — inside each phase, agents run
  concurrently.
- **Verify ≠ redundancy**: N identical reviewers find the same things; N
  lenses find different things. Sizing: 2–3 lenses for a focused slice, 4 for
  one with a dangerous shared surface.
- **Sequential gates in the main loop** (not agents) keep Windows stable and
  make the acceptance gate (`turbo run typecheck`) a single honest signal.
- **Economics**: Haiku/Sonnet do volume, Opus only verifies, the main model
  only locks contracts, triages, and fixes. That is what made the pattern
  "effective and economical".
