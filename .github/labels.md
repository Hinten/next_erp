# Issue labels — task type & model routing

Authoritative spec for the `task:` label family. This file is the source of
truth for each label's name, colour and meaning; the labels on GitHub are
generated from it by hand (`gh label create … --force`).

## Why this family exists

Issues used to be triaged only by `complexity: low/medium/high`. That says how
hard something *feels*, not **which Claude model should pick it up**. The
`task:` family answers that: it describes the **type of task**, and the type
maps to a model by a documented rule rather than a gut call.

`complexity:` is **not** replaced — it stays as an independent signal. `task:`
is purely additive.

## Model routers — at most one per issue

The router picks the model. They are a light→dark ramp on one hue, so
cheap → heavyweight reads as an ordered family in the issue list.

| Label                    | Model      | Colour   | Means                                                                                     |
| ------------------------ | ---------- | -------- | ----------------------------------------------------------------------------------------- |
| `task: mechanical`       | **Haiku**  | `c8e1ff` | Rote, tightly-scoped, single-pattern change with an unambiguous spec.                       |
| `task: standard-feature` | **Sonnet** | `54aeff` | Feature/port following an existing repo pattern or a clear legacy (`.old/`) reference.      |
| `task: complex-domain`   | **Opus**   | `0969da` | Correctness-critical or multi-subsystem work (fiscal, rules, concurrency, protocol).        |
| `task: architecture`     | **Fable**  | `033d8b` | Foundational/greenfield/cross-cutting design, or the largest and most ambiguous work.       |

Sorting hints, distilled from the repo's own risk profile:

- **Haiku** — add an enum value, a pt-BR field label, normalise a default, a
  pure format/ZPL transform, a careful rename. Low cross-file reasoning, low
  blast radius.
- **Sonnet** — the workhorse: `TableView`/`ObjectView` screens, editor tabs, row
  actions, new-collection schema modelling, straightforward domain ports.
  Multi-file but well-trodden.
- **Opus** — NF-e/fiscal engines and SEFAZ wire format, generated Firestore
  rules and permissions, money rounding, transactional concurrency, marketplace
  order-import protocol, security lockdowns, large ports. Per `CLAUDE.md` a
  swallowed SEFAZ or rules error is expensive here, so **fiscal and rules-gen
  work defaults to Opus regardless of size** — see `#496`–`#500`, templated but
  still routed to Opus.
- **Fable** — reserved for roughly the top 5%: greenfield architecture and
  runtime choices, cross-cutting foundations everything else inherits, and
  ambiguous problems with a wide solution space.

## Overlay tags — zero or more per issue

Overlays describe cross-cutting *nature*. They never override the router; they
are deliberately off-ramp in colour so they never blend into it.

| Label                  | Colour   | Means                                                     | Effect on routing                                            |
| ---------------------- | -------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| `task: ai-llm`         | `006b75` | Builds or reasons about LLM/agent/MCP behaviour.           | Advisory: load the `claude-api` skill. Router still picks.    |
| `task: research-spike` | `f9d0c4` | Deliverable is analysis or a recommendation, not code.     | Output is a decision, not a PR.                               |
| `task: ops-deploy`     | `fef2c0` | One-time infra/deploy/secret/console work.                 | Usually needs a **human** (console access), not a model.      |

## The rule

**The single `task:` router determines the model; overlays add nature.**

- `#542` AI product description → `task: standard-feature` + `task: ai-llm`
  → Sonnet, with the AI skill loaded.
- `#575` deploy `apps/whatsapp` → `task: ops-deploy` only → human.
- `#526` AI agent runtime → `task: architecture` + `task: ai-llm` → Fable.

## Router-less issues are intentional

An issue with **no** router is human-first or blocked work — console/deploy
tasks and decisions waiting on the owner. The four router filters therefore
cover 162 of 172 open issues, and the remainder is explicitly the human queue.

There is no `needs-clarification` label. Un-routable issues are already marked
by the pre-existing triage labels, and duplicating them would mean two labels
for one state:

| Existing label   | Use it for                                                       |
| ---------------- | ---------------------------------------------------------------- |
| `needs-decision` | Blocked on a decision from Lucas — post it in the comments.       |
| `needs-design`   | Needs a UX/design call before it can be specced.                  |
| `no-breakdown`   | Too large or too vague to decompose; needs Lucas.                 |

So a handful of issues (today `#379`, `#557`) carry **no** `task:` label at all.
That is by design — find them via the three labels above, not a `task:` filter.

## Querying

```bash
gh issue list --state open --label "task: complex-domain"        # all Opus work
gh issue list --state open --label "task: standard-feature" --label "task: ai-llm"   # Sonnet + AI skill
gh issue list --state open --label "no-breakdown"                # blocked / needs Lucas
```

## Maintaining

When adding a label or changing a colour, edit this file **and** apply it:

```bash
gh label create "task: <name>" --color <hex> --description "<desc>" --force
```

Apply labels to issues additively — `gh issue edit N N N --add-label "…"`.
Never use the replace-semantics label endpoint (`PUT …/labels`) on these
issues: it would wipe `complexity:` and the domain labels.
