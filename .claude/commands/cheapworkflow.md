---
description: Implement → adversarially verify → gate → ship one PR-sized slice via multi-agent Workflow orchestration.
argument-hint: <issue number or slice description>
---

# /cheapworkflow — implement → adversarially verify → gate → ship

Deliver one PR-sized slice through a Workflow orchestration. Invoking this
command is the user's explicit opt-in to multi-agent orchestration (the
Workflow tool) — do not launch this orchestration unless the user typed
`/cheapworkflow` themselves.

**Input**: $ARGUMENTS — the slice to build, ideally an issue number plus the
approved plan and agreed deviations. No approved plan yet? STOP and present
one first; this command starts at "approved, build it".

**Before writing your first workflow script**, read "Workflow script
template" below (the annotated script skeleton — copy its structure
exactly). For a fully-worked realistic run — including a user-authorized
Fable escalation — read "Worked example" below.

## Checklist (track this)

```
- [ ] 0. Contracts locked; file ownership assigned; branch fresh off default
- [ ] 0b. Extremely complex component? → ask the user before any Fable agent
- [ ] 1. Implement fan-out launched (shared CTX + per-agent tasks)
- [ ] 2. Adversarial verify (distinct lenses, read-only, effort high)
- [ ] 3. Findings triaged honestly; fixes applied; own diff review done
- [ ] 4. Gates SEQUENTIALLY: package tests → workspace typecheck → lint
- [ ] 5. Draft PR (`Closes #NNN`) → CI watch → MERGEABLE → ready-for-review
- [ ] 6. Keep monitoring: CI AND code reviews (fix same-PR, reply, re-watch)
```

## Non-negotiable rules

These make the fan-out cheap and correct — violating any of them is how
parallel agents produce garbage:

- **Lock contracts first, yourself.** Exact signatures, type shapes,
  deterministic formulas quoted character-exact, file paths. A value that must
  stay identical across two files is quoted byte-exact with "must stay
  identical to X or Y breaks".
- **Never let anyone guess.** Anything you could not verify becomes an agent
  instruction: "FIRST verify <thing> in <file> — record what you found in
  notes".
- **One agent per file.** Sibling agents' new files are referenced by
  contract only ("a concurrent agent owns that file — code against the
  signature").
- **Agents never run package-manager/build/test commands.** The main loop
  gates sequentially afterward (parallel builds thrash the machine and prove
  nothing mid-flight).
- **Verifiers are read-only refuters** with *distinct lenses* (invariants /
  error-and-control-flow / reference parity / tests-types-completeness):
  quote proof or drop the finding; empty findings is a valid outcome; list
  approved deviations so they aren't re-reported.
- **Zero findings ≠ done.** Review the diff yourself before gating. Truncated
  workflow results: read `<transcriptDir>/journal.jsonl` for the full
  per-agent returns.
- **Triage honestly.** Fix real findings; reject wrong ones with reasoning
  you'd defend in review. Convergent findings (several verifiers, same
  defect) are almost always real.

## Model ladder & Fable escalation

| Tier | Use for |
|---|---|
| `haiku` | mechanical plumbing (barrels, flag threading, boilerplate) |
| `sonnet` | implementation + tests |
| `opus` (`effort: 'high'`) | adversarial verification |
| main loop | contracts, triage, gates, only the hardest fixes |

**Fable escalation** — for an extremely complex component (novel algorithm,
dangerous shared/concurrent surface, correctness-critical cross-cutting
invariant), specific agents may run on `fable`, as implementers and/or
verifiers. **Never silently**: before launching, ask the user for
authorization, naming (a) which agents, (b) why the component qualifies,
(c) that it costs more. Default ladder on a "no" — the main loop hand-reviews
the hard component instead. The authorization wording and script wiring are
shown in "Worked example" below.

## Ship (phase 4–6 details)

1. Targeted tests per touched package, then the workspace typecheck (the
   acceptance gate), then lint — one at a time.
2. Format your touched files only; commit per repo conventions; push a
   **draft PR** whose body ends with `Closes #NNN`.
3. `gh pr checks <pr> --watch` in the background; confirm the PR is
   MERGEABLE (a base-branch conflict silently blocks CI). On red,
   distinguish a real regression from a known-flaky lane before re-running.
4. Mark ready-for-review when green, then keep watching for code-review
   comments: triage each finding, fix in the SAME PR, reply pointing at the
   fix commit, re-watch CI.

---

## Reference: workflow script template (annotated)

Copy this structure exactly; fill the `<placeholders>`. Scripts are **plain
JS** (no TypeScript annotations) and must never call
`Date.now()`/`Math.random()`/argless `new Date()` (resume safety — pass
timestamps via `args` or stamp after the workflow returns).

```js
export const meta = {
  name: '<slug>',
  description: 'Implement + adversarially verify <slice>',
  phases: [
    { title: 'Implement', detail: '<agent split>' },
    { title: 'Verify', detail: '<N> refuters: <lenses>', model: 'opus' },
  ],
}

// ONE shared context block, prepended to EVERY agent prompt. Everything an
// agent needs to act correctly without asking questions lives here.
const CTX = `# Shared context — <slice>
WORKING DIR (edit HERE, absolute): <path>
<other absolute paths agents need — e.g. a reference/legacy copy>
DO NOT run package-manager/build/test commands — the orchestrator gates afterward. Only read/write files.

## Hard project rules
<the ones that apply, from the project's CLAUDE.md>

## Verified facts (file:line — trust these; re-verify only where told)
<facts you pinned during contract-locking>

## Approved deviations (do NOT re-report)
<deviations the user already accepted>

## Cross-agent contracts (code EXACTLY against these)
<exact signatures, formulas quoted character-exact, wire shapes — per agent>`

phase('Implement')
// Structured returns: `notes` is the channel where implementers hand the
// verifiers their verified facts, deviations, and open uncertainties.
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

### Structural notes

- The `parallel()` barrier between Implement and Verify is genuinely required
  (verifiers need the finished diff). Inside each phase, agents run
  concurrently up to the pool cap.
- `parallel()` resolves a failed agent to `null` — hence the
  `.filter(Boolean)` before using results.
- 2–4 implementers and 2–3 verify lenses for a focused slice; a 4th lens only
  when there is a genuinely dangerous shared surface.
- Keep per-agent prompts to: the CTX + their owned files + their "FIRST
  verify" steps + their contract. Nothing about other agents' internals.

---

## Reference: worked example — a full run with all four model tiers

Fictional but realistic slice: **issue #312 — port the payment-webhook
reconciliation module** from a legacy service into `apps/payments`. The
approved plan names one deliberately hard component: `reconcileLedger.ts`, a
concurrent read-modify-write over a shared ledger doc that both the old and
new service mutate during a dual-run migration.

This section shows the FULL sequence: contract-locking → the Fable
authorization ask → the script with haiku/sonnet/fable implementers and
opus/fable verifiers → triage → gates. Adapt names and paths; keep the
shapes.

### 1. Contract-locking (main loop, before anything launches)

Notes produced by reading the code yourself:

```
- webhook wire: POST body = { event_id: string, type: 'payment.updated',
  data: { payment_id, status, amount_cents } }  (verified apps/payments/app/api/webhooks/psp/route.ts:41-58)
- idempotency key = event_id; store at ledger/{accountId}/events/{event_id}  (verified legacy service src/reconcile.js:88)
- ledger doc formula (MUST stay identical in reconcileLedger.ts AND its test
  fixtures, byte-exact): docId = `led_${accountId}_${yyyymm}`  (legacy src/ledger.js:12)
- amounts are INTEGER CENTS end-to-end; any float appearing anywhere is a bug
- "FIRST verify" items for agents: the retry header name the PSP actually
  sends (agents read the captured fixtures in test/fixtures/psp/*.json — do
  not guess); whether the legacy service acked 200 on duplicate events
  (read legacy src/reconcile.js:100-130 and record in notes)
- file ownership: A1 plugin schema+client / A2 route+queue plumbing /
  A3 reconcileLedger.ts + tests / V1..V3 verify
```

### 2. The Fable authorization ask (before launching)

`reconcileLedger.ts` qualifies as extremely complex: a concurrent
read-modify-write on a doc two services mutate, where a lost update corrupts
money. So the main loop asks — and waits:

> This slice has one extremely complex component: `reconcileLedger.ts` — a
> concurrent ledger merge both services write during dual-run; a lost update
> here corrupts balances. I'd like to escalate two agents to **Fable** (our
> top tier, costs more than the default ladder):
> 1. the **implementer** of `reconcileLedger.ts` (+ its tests),
> 2. one **verifier** dedicated to the concurrency/lost-update lens.
> Everything else stays on the default Haiku/Sonnet/Opus ladder. Authorize
> the two Fable agents? (If not, I'll implement it on Sonnet and hand-review
> the concurrency surface myself.)

User: "authorized". Only then does the script below use `model: 'fable'` —
and only on those two agents.

### 3. The workflow script

```js
export const meta = {
  name: 'payments-312-reconcile',
  description: 'Implement + adversarially verify #312 (PSP webhook reconciliation)',
  phases: [
    { title: 'Implement', detail: 'plugin schema / route+queue / ledger core (fable)' },
    { title: 'Verify', detail: '3 refuters: concurrency (fable), errors, tests', model: 'opus' },
  ],
}

const CTX = `# Shared context — #312 PSP webhook reconciliation
WORKING DIR (edit HERE, absolute): C:/repos/acme-erp
Legacy reference (READ-ONLY): C:/repos/acme-erp/.legacy
DO NOT run package-manager/build/test commands — the orchestrator gates afterward. Only read/write files.

## Hard project rules
- No generic catch: narrow on a specific error class + rethrow the rest.
- Money is INTEGER CENTS everywhere; a float is a defect.
- One timestamp per operation, threaded from the caller.

## Verified facts (trust these; re-verify only where told)
- Webhook body: { event_id, type: 'payment.updated', data: { payment_id, status, amount_cents } } (route.ts:41-58).
- Idempotency key = event_id at ledger/{accountId}/events/{event_id} (.legacy/src/reconcile.js:88).
- Ledger doc id formula — byte-exact, MUST stay identical in reconcileLedger.ts and every fixture:
  \`led_\${accountId}_\${yyyymm}\`  (.legacy/src/ledger.js:12)

## Approved deviations (do NOT re-report)
- D1: duplicate events ack 200 AND log (legacy acked silently).

## Cross-agent contracts (code EXACTLY against these)
A1 exports (packages/payments-client): pspEventSchema (tolerant Zod, passthrough),
  parsePspEvent(raw: unknown): PspEvent | null.
A3 exports (apps/payments/lib/reconcileLedger.ts):
  reconcileLedger(deps: { db: Firestore }, event: PspEvent, now: number): Promise<'applied' | 'duplicate'>
  // transactional: re-read inside the tx, apply-once by event_id, integer-cents math only.
A2 calls parsePspEvent + reconcileLedger against those signatures — the files
are owned by A1/A3; do not create them.`

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
  // Mechanical-only surface → haiku.
  () => agent(CTX + `
# YOUR TASK (A1 — plugin schema + parser, mechanical)
Create packages/payments-client/src/pspEvent.ts per the A1 contract + barrel export
+ pspEvent.test.ts (valid body, tolerated unknown fields, malformed → null).
FIRST verify the PSP retry header name in test/fixtures/psp/*.json — record it in notes.
Touch nothing else.`,
    { label: 'impl:plugin', phase: 'Implement', model: 'haiku', schema: RESULT_SCHEMA }),

  // Standard implementation + tests → sonnet.
  () => agent(CTX + `
# YOUR TASK (A2 — route + queue plumbing)
Wire apps/payments/app/api/webhooks/psp/route.ts: parsePspEvent (null → 200 + drop),
enqueue onto the existing task queue (see lib/queue.ts pattern), ack fast.
FIRST verify how the legacy service acked duplicates (.legacy/src/reconcile.js:100-130)
— record in notes. Extend route.test.ts. Do not create A1/A3's files.`,
    { label: 'impl:route', phase: 'Implement', model: 'sonnet', schema: RESULT_SCHEMA }),

  // The extremely complex component — fable, EXPLICITLY authorized by the user above.
  () => agent(CTX + `
# YOUR TASK (A3 — reconcileLedger core; you are the escalated top-tier agent)
Implement reconcileLedger per the contract: a Firestore transaction that re-reads the
ledger doc + the event marker inside the tx, applies once, writes integer cents only,
and returns 'applied' | 'duplicate'. The doc id formula is byte-exact from CTX.
Tests: apply-once under simulated concurrent duplicate delivery; balance math property
cases; the formula literal asserted.`,
    { label: 'impl:ledger', phase: 'Implement', model: 'fable', schema: RESULT_SCHEMA }),
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

const VCTX = CTX + `
# YOUR ROLE: adversarial verifier (READ-ONLY; no edits, no build/test commands)
git diff for the surface, then READ the full touched files. Refute with quoted proof only;
drop anything that does not survive re-reading. Empty findings is valid. Cross-check the
implementation agents' seams (imports/exports/signatures).`

const verdicts = await parallel([
  // The dangerous lens gets the escalated tier too (user-authorized).
  () => agent(VCTX + `
# LENS 1 — concurrency + money invariants (escalated)
Attack: lost-update windows in the transaction (is EVERY read the tx depends on inside it?);
duplicate delivery races; the byte-exact doc-id formula in code AND fixtures; any float
sneaking into amount math; partial-failure recovery on tx abort.`,
    { label: 'verify:concurrency', phase: 'Verify', model: 'fable', effort: 'high', schema: FINDINGS_SCHEMA }),

  () => agent(VCTX + `
# LENS 2 — error semantics + control flow
Attack: catch narrowing everywhere; the drop-vs-retry boundary (malformed → 200+drop,
infra → throw for queue retry); ack ordering; idempotent replay end-to-end.`,
    { label: 'verify:errors', phase: 'Verify', model: 'opus', effort: 'high', schema: FINDINGS_SCHEMA }),

  () => agent(VCTX + `
# LENS 3 — tests, types, completeness
Attack: do tests assert real invariants (formula literal, apply-once, cents) or tautologies?
Do A1/A2/A3's seams compile together (exact names/shapes)? Anything touched outside the
owned files? Style parity with the surrounding code?`,
    { label: 'verify:tests', phase: 'Verify', model: 'opus', effort: 'high', schema: FINDINGS_SCHEMA }),
])

const all = verdicts.filter(Boolean).flatMap((v) => v.findings)
log('Verify: ' + all.length + ' findings (' + all.filter((f) => f.severity === 'blocker').length + ' blockers)')
return { implement: impl.filter(Boolean), findings: all }
```

### 4. Triage → gates → ship (main loop)

- Suppose the concurrency lens returns one major finding ("the event-marker
  read happens before the transaction starts — a duplicate delivered in that
  window double-applies", with the quoted lines) and the other lenses return
  none: fix it on the branch, add the regression test, and note that a
  finding echoed by the escalated lens on the component it was escalated FOR
  is exactly the escalation paying for itself.
- Then, sequentially: package tests → workspace typecheck → lint; format your
  touched files; commit; draft PR ending `Closes #312`; background CI watch;
  MERGEABLE check; ready-for-review on green; keep watching CI **and** review
  comments — review fixes land in the same PR with a reply pointing at the
  fix commit.
