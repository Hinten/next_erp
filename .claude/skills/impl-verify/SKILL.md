---
name: impl-verify
description: >-
  Run a well-scoped implementation slice as a multi-agent Workflow: lock
  contracts, fan out implementation agents with disjoint file ownership,
  adversarially verify with independent high-effort reviewers, gate
  sequentially, and ship a draft PR. Use when the user says: /impl-verify,
  "run the implement-verify workflow", "build this slice with the workflow",
  "fan-out implement + adversarial verify", or "ultracode this slice". Not for
  trivial edits, pure research, or single-file changes.
---

# impl-verify — implement → adversarially verify → gate → ship

Deliver one PR-sized slice through a **Workflow** orchestration: parallel
implementation agents coding against **locked contracts**, then independent
**adversarial verifiers**, then the main loop triages findings, runs the gates
sequentially, and ships a draft PR. Invoking this skill is the user's explicit
opt-in to multi-agent orchestration (the Workflow tool).

**Input** (`args` or the conversation): the slice to build — ideally an issue
number plus the approved plan and any agreed deviations. If there is no
approved plan yet, STOP and present one first — this skill starts at
"approved, build it".

## Phases

### 0. Contract-locking (main loop, before launching anything)

- Read the key files yourself and pin **exact contracts**: signatures, type
  shapes, deterministic formulas (quoted character-exact), file paths. A value
  that must stay identical across two files is quoted byte-exact with "must
  stay identical to X or Y breaks".
- Anything you could not verify yourself becomes an agent instruction: "FIRST
  verify <thing> in <file> — record what you found in notes". Never guess.
- **One agent per file.** Agents reference sibling agents' new files by
  contract only ("a concurrent agent owns that file — code against the
  signature").
- Branch fresh off the updated default branch; install dependencies if the
  lockfile moved.

### 1. Implement fan-out (Workflow phase)

2–4 agents in parallel, each prompt carrying the shared context block
(template below): absolute working-directory paths, the project's hard rules
(from CLAUDE.md), the verified facts + contracts + approved deviations, the
instruction **"do not run package-manager/build/test commands"** (the main
loop gates sequentially), and a structured `{ filesChanged, notes }` return.

### 2. Adversarial verify (Workflow phase, after the barrier)

2–4 read-only reviewers at `effort: 'high'`, each with a **distinct lens** —
diversity catches what redundancy can't. Typical lenses: domain invariants;
error semantics + control flow (retry/idempotency, write ordering,
partial-failure recovery); parity vs a reference implementation (they read the
reference themselves; approved deviations listed so they aren't re-reported);
tests/types/completeness (real assertions vs tautologies, do the agents' seams
compile together). Rules: start from `git diff`, read the full files, **quote
proof or drop the finding**, empty findings is a valid outcome.

### 3. Triage + fix (main loop)

- Findings arrive in the workflow result (or `<transcriptDir>/journal.jsonl`
  when truncated). Fix the real ones; reject the wrong ones with reasoning
  you'd defend in review. Convergent findings are almost always real.
- **Zero findings ≠ done** — review the diff yourself before gating.

### 4. Gate + ship (main loop, sequential)

1. Targeted tests per touched package → the workspace typecheck → lint —
   one at a time, never in parallel.
2. Format your touched files only; commit per repo conventions; push a
   **draft PR** whose body ends with `Closes #NNN`.
3. Watch CI in the background (`gh pr checks --watch`); verify the PR is
   MERGEABLE. On red, distinguish a real regression from a known-flaky lane.
4. Mark ready-for-review when green. **Monitoring includes code reviews**:
   keep checking for review comments, triage each finding (fix or push back
   with reasoning), fix in the SAME PR, reply pointing at the fix commit,
   re-watch CI.

## Model ladder & Fable escalation

Default ladder — this is what makes the pattern economical:

| Tier | Use for |
|---|---|
| `haiku` | mechanical plumbing (barrels, flag threading, boilerplate) |
| `sonnet` | implementation + tests |
| `opus` (`effort: 'high'`) | adversarial verification |
| main loop | contracts, triage, gates, and only the hardest fixes |

**Escalation to `fable`** (top-tier agents) is available for extremely complex
components — novel algorithms, dangerous shared/concurrent surfaces,
correctness-critical cross-cutting invariants — as implementers and/or as
verifiers. It is **never silent**: before launching, ask the user for
authorization, naming (a) which agents you want on `fable`, (b) why that
component is extremely complex, and (c) that it costs more. Only escalate the
named agents on a yes; on a no (or no answer), run the default ladder — the
main loop can still hand-review the hard component itself.

## Workflow script template

Plain JS (no TS annotations); never call `Date.now()`/`Math.random()` inside
the script (resume safety).

```js
export const meta = {
  name: '<slug>',
  description: 'Implement + adversarially verify <slice>',
  phases: [
    { title: 'Implement', detail: '<agent split>' },
    { title: 'Verify', detail: '<N> refuters: <lenses>', model: 'opus' },
  ],
}

const CTX = `# Shared context — <slice>
WORKING DIR (edit HERE, absolute): <path>
<other absolute paths agents need>
DO NOT run package-manager/build/test commands — the orchestrator gates afterward. Only read/write files.

## Hard project rules
<the ones that apply>

## Verified facts (file:line — trust these; re-verify only where told)
<facts>

## Approved deviations (do NOT re-report)
<deviations>

## Cross-agent contracts (code EXACTLY against these)
<contracts>`

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
  // A2..An — disjoint file ownership; 'haiku' for mechanical-only agents;
  // 'fable' ONLY for a component the user explicitly authorized escalating.
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
git diff for the surface, then READ the full touched files. Refute with quoted proof only;
drop anything that does not survive re-reading. Empty findings is valid. Cross-check the
implementation agents' seams (imports/exports/signatures).`

const verdicts = await parallel([
  () => agent(VCTX + `\n# LENS 1 — <lens>`,
    { label: 'verify:<l1>', phase: 'Verify', model: 'opus', effort: 'high', schema: FINDINGS_SCHEMA }),
  // LENS 2..N — swap in 'fable' only with the user's explicit authorization
])

const all = verdicts.filter(Boolean).flatMap((v) => v.findings)
log('Verify: ' + all.length + ' findings (' + all.filter((f) => f.severity === 'blocker').length + ' blockers)')
return { implement: impl.filter(Boolean), findings: all }
```
