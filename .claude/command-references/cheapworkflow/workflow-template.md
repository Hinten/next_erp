# Workflow script template (annotated)

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

## Structural notes

- The `parallel()` barrier between Implement and Verify is genuinely required
  (verifiers need the finished diff). Inside each phase, agents run
  concurrently up to the pool cap.
- `parallel()` resolves a failed agent to `null` — hence the
  `.filter(Boolean)` before using results.
- 2–4 implementers and 2–3 verify lenses for a focused slice; a 4th lens only
  when there is a genuinely dangerous shared surface.
- Keep per-agent prompts to: the CTX + their owned files + their "FIRST
  verify" steps + their contract. Nothing about other agents' internals.
