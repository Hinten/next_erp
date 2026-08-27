# Copilot code review instructions

This is the **reviewer's checklist** for `@delfrance/erp-next`. The full engineering
contract is the root [`CLAUDE.md`](../CLAUDE.md) — read it for the reasoning behind
every rule below. Detail also lives in the per-app `CLAUDE.md` files
(`apps/web/CLAUDE.md`, `apps/functions/CLAUDE.md`, `apps/nfe/CLAUDE.md`, …), the ADRs
under `apps/docs/`, and package READMEs; consult them when a diff touches those areas.

The repo is a pnpm/Turborepo monorepo (Next.js apps + Cloud Functions) on a Firebase
backend running **Firestore Enterprise edition**. Several rules exist because Enterprise
behaves differently from the Firestore most people know.

## How to review here

- **Fewer, higher-confidence findings beat broad speculation.** A wrong finding costs
  more than a missed nitpick.
- **Do not raise formatting or style nits.** Prettier owns formatting and `pnpm format:check`
  is a CI gate; ESLint owns the mechanical rules. If a linter would catch it, skip it.
- **Comments, identifiers, commit messages and PR text are in English.**
- Prefer pointing at the invariant that was violated over rewriting the author's approach.

## Blocking invariants — flag these every time

**Generated rulesets.** `firestore.rules` and `firestore.e2e.rules` are emitted by
`packages/rules-gen` from the Zod collection metadata. Flag: any hand-edit to either file;
any change to a `*Meta` permission/path, a PERM constant, or a validator whitelist that
does **not** come with both files regenerated (`gen:rules` **and** `gen:rules:e2e`) and
both vitest snapshots in `packages/rules-gen/src/__snapshots__/` refreshed. Regenerating
only one reds CI. `firestore.e2e.rules` opens every `e2e_`-prefixed collection, so it must
never reach production.

**Firestore Enterprise indexing.** An unindexed query does **not** fail — it silently
full-scans, and Enterprise bills data scanned. Enterprise auto-creates zero indexes.
Flag: a new or changed `meta.defaultQuery`, `meta.pickerRecencySort`, or TableView
update-monitor query with no matching entry in `firestore.indexes.json`. Also flag index
JSON copied from Standard-edition docs — Enterprise omits the implicit trailing `__name__`
field — and any code assuming the database is `(default)`: it is literally named `default`.

**Query shapes ported from the legacy Flutter app (`.old/`).** These were written against
Firestore Standard and often work around limits that no longer exist. But a "modern" shape
is not automatically cheaper: a second inequality is a post-filter that does not reduce
index entries scanned. Flag a rewrite that trades one inequality for two without measuring.

**No generic `catch`.** Narrow with `err instanceof <SpecificError>` (`FirebaseError`,
`ZodError`, an in-repo class) and `throw err` for anything else. `err instanceof Error`
does **not** count — it is the parent of every exception. `apps/nfe` and
`packages/integrations/nfe` deliberately opt out of the lint rule, so review those by hand.

**Optional Firestore fields.** Use `.nullable().default(null)`. Never a bare `.optional()`
without `.nullable()` in the chain — the Firebase SDK rejects `undefined` in
`addDoc`/`setDoc`. `.nullable().optional()` is correct only for server-stamped fields the
client never writes.

**Write races.** Firestore imposes no ordering, and second writers are routine:
out-of-order provider webhooks, the notification sweep re-driving hours-old payloads,
Cloud Tasks retries, a trigger racing the client write that fired it, two operators in
two tabs. (The legacy Flutter app is **not** one of them — it never writes a document
this app writes; there is no dual run.) `runTransaction` retries the callback but does
not re-derive values captured in the closure, so anything read before an `await` is
re-applied verbatim over the winner. Flag: a `merge()`/`update()`/transaction that can
silently lose without the author saying what happens to the loser; a predicate re-checked
against a read taken *outside* the transaction; and cross-unit timestamp comparisons —
`ultimaModificacao` is µs on pedido/pagamento/produto but **ms** on the ML links, and
`historicoFtIni.data` is ms while `historicoEstadoPedido.data` is µs. See ADR 0011.

**Version pins.** `firebase-admin` (`14.2.0`) and `firebase-functions` (`7.3.2`) are pinned
**exact** in the pnpm catalog *and* in all five deploy-artifact manifests — deploy artifacts
ship no lockfile, so a `^` range installs an untested version in production. `next` must be
an exact literal (never `catalog:`, never a range) in the 7 `apps/*/package.json` that have
an `apphosting.yaml`, or the App Hosting buildpack blocks the deploy. Flag any range or
`catalog:` creeping back into those spots.

**Client-first `apps/web`.** Default to `'use client'`. A new Server Component, Server
Action, route handler or `middleware.ts` in `apps/web` needs explicit justification —
`app/layout.tsx` is the one standing exception. Server compute belongs in the API-only
sibling apps (`apps/nfe`, `apps/mercado-livre`, …) or `apps/functions`.

**CI lane wiring.** Never add a top-level `paths:` to an e2e lane and never pin a check
that can be skipped: a non-matching `paths:` publishes *no check at all*, and a job skipped
by `if:` publishes `skipped`, which GitHub counts as **satisfying** a required check. Both
are silent passes. New e2e specs are routed purely by filename suffix
(`.cadastros.e2e.spec.ts`, `.vendas.e2e.spec.ts`, `.emulator.e2e.spec.ts`, `.smoke.spec.ts`) —
do not add an e2e job to `ci.yml`. An e2e spec asserts a **behaviour**, never a deployment
state.

**Production data and infra.** Production has not migrated yet (ADR 0013). Anything a
change needs *run* against real data or infra — backfills, index/rule/TTL deploys, claim
re-mints, webhook re-registration — belongs to a coordinated migration window and must be
surfaced as a `needs-migration-window` issue, **never** left as a TODO. Flag a PR that
quietly assumes such a step already happened. A Firestore import fires no Cloud Functions
triggers, so derived state must already be in the export.

**Shape changes to existing data** get a one-time `tools/migrations` script (idempotent,
dry-run by default, pure `transform.ts` with unit tests) — not dual-shape reads, a compat
branch, lazy backfill-on-read, or a trigger-maintained derived field. There is a cutover;
permanent compat code pays for something already bought.

## Repo mechanics worth knowing

- New schema → `packages/schemas/src/<domain>.ts`, barrel-exported and registered in
  `src/registry.ts` (`ALL_DOMAINS`), then both rulesets regenerated.
- New collection → `defineCollection({ path, schema })`. Partial updates go through the
  handle's `merge()`, never `setDoc(ref, patch, { merge: true })` on a converted ref — the
  converter full-parses the patch and the merge mask then overwrites stored siblings.
- Emulators are used only in named carve-outs (`ci-storage.yml`, `ci-rules.yml`,
  `ci-mercado-livre.yml`, `e2e-emulator.yml`). Every other e2e spec hits staging. The
  Pipelines API does not run in the emulator.
- Twelve custom ESLint rules live in `packages/config-eslint/rules/`. Flat config **replaces**
  a rule by name rather than merging, so a workspace that redeclares `no-restricted-syntax`
  silently drops the base selectors.
- Agents never run `firebase deploy`. Deploying rules is a manual, coordinated human step.
