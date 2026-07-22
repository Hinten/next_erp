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

**Before writing your first workflow script**, read
[workflow-template.md](../command-references/cheapworkflow/workflow-template.md)
(the annotated script skeleton — copy its structure exactly). For a
fully-worked realistic run — including a user-authorized Fable escalation —
read [example-run.md](../command-references/cheapworkflow/example-run.md).

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
shown in
[example-run.md](../command-references/cheapworkflow/example-run.md).

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

