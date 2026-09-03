# CLAUDE.md

Detail lives where it is cheaper: the per-app `CLAUDE.md` files, the
skills in `.claude/skills/`, the ADRs under `apps/docs/`, and package READMEs.

## What this is

`@delfrance/erp-next` (Apache-2.0) — a multi-app Next.js/Turborepo monorepo, the
OSS rewrite of the Delfrance Flutter ERP at feature parity on the same data
model. See `README.md` and `.github/CONTRIBUTING.md`. It **replaces** that app at a
single cutover (rule 8) and never runs beside it. The Flutter app is a separate
repo; a read-only copy sits at `.old/` (gitignored, present only in local
checkouts) and is the **parity reference for ports**.

CI — the nine lanes in `.github/workflows/` run **concurrently**, gated on
nothing. **"CI green" means "the suite passed."** Each lane derives its own scope
from the workspace dependency graph and reports through one unskippable check;
`ci.yml` excludes the nfe/freight/storage/functions/mercado-livre tests, which
the domain pipelines `ci-{nfe,freight,storage,rules,mercado-livre}.yml` own —
**an exclusion is a promise that the owning lane runs them, so when that lane
skips they run nowhere.** `ci.yml` still lints, typechecks and builds the full
graph unfiltered. **Touching `.github/workflows/` → the `ci-lanes` skill**, which
carries the whole design.

Five rules you must not break without reading it first:

1. ⚠️ **Never put a `paths:` on a lane's `pull_request:`, and never pin a check
   that can be skipped.** A non-matching `paths:` publishes **no check at all** —
   not a skip, *nothing* — and a job skipped by `if:` publishes `skipped`, which
   GitHub counts as **satisfying** a required check. Both are silent passes.
2. ⚠️ **A check-run name carries no workflow prefix**, so every name must be
   unique repo-wide. The fifteen pinnable ones are
   `E2E gate (cadastros|vendas|emulator)`,
   `CI gate (nfe|freight|mercado-livre|storage|rules)` and — since `ci.yml` split
   its single `lint-typecheck-test` job into seven concurrent ones —
   `CI typecheck`, `CI lint`, `CI format check`, `CI test`,
   `CI test web 1of2`, `CI test web 2of2`, `CI build`. ⚠️ The last two are a
   `vitest --shard` **partition** of `@delfrance/web`, and `CI test` excludes
   that workspace: change one and you must change the others, or a slice of the
   222-file suite runs **nowhere** while every job still reports green.
   `ci-lane-gates.test.js` asserts the partition.
3. ⚠️ **A job-level `if:` replaces the implicit `success()`** — putting one on a
   downstream job makes it run even after its upstream failed. Let `needs:` carry
   the skip instead.
4. ⚠️ The `push:` triggers **keep** their `paths:` deliberately; only
   `pull_request:` goes without.
5. ⚠️ **The workflow YAML comes from the MERGE REF, the checkout from the PR
   HEAD — so a scope step must degrade to running the lane, never to failing
   the job.** The caller is always at least as new as
   `.github/scripts/e2e-affected.mjs` and never older, so on a branch older than
   the script `node` exits 1 (`Cannot find module`) *before* the script's own
   fail-safe can fire, killing `changes` and reddening a required check that only
   a rebase clears. Every invocation is wrapped in
   `if ! node …; then <emit the verdict>; fi`. ⚠️ **The direction depends on the
   mode**: `--roots` degrades to `run_e2e=true` (a wrong skip ships unverified
   code), `--only-paths` to `run_e2e=false` — that mode serves `nfe-live` alone,
   which emits at SEFAZ homologação against a rate-limited endpoint, and
   `NFE_CI_LIVE_ENABLED` is `true`. Same rule inside the script's `catch`.

Enforced by `packages/config-eslint/rules/ci-lane-gates.test.js` — every workflow
must be a registered lane or an explicitly excused one, and no scope invocation
may go unguarded.

Every `pull_request` base filter is
`[master, main, production, 'claude/**', 'feat/**', 'fix/**']`. That key matches
the PR's **base**, so a **stacked PR** must sit on one of those prefixes — on
anything else (`chore/`, `docs/`, …) it reports zero checks, not failures.

## Critical rules

1. **Firestore is ENTERPRISE edition — the usual limits do not apply, and it
   cuts both ways.** A query never needs an index to *run*: an unindexed
   `where`/`orderBy`/`collectionGroup` does **not** throw `FAILED_PRECONDITION`
   and offers no one-click index link — it silently **full-scans**, and
   Enterprise bills **data scanned**, so the mistake lands on the invoice rather
   than in your face. Enterprise auto-creates **zero** indexes: declare them in
   `firestore.indexes.json`. Index hot queries; when possible, filter
   client-side to use the firebase local cache. **Three query classes are
   index-MANDATORY** — every `meta.defaultQuery`, every `meta.pickerRecencySort`,
   every TableView update-monitor query — enforced by the
   `delfrance/default-query-needs-index` lint **error** plus the
   `packages/schemas/src/defaultQuery.indexes.test.ts` backstop; both print
   paste-ready JSON. Two more deltas: the database is literally named
   **`default`**, not `(default)` — pass it explicitly or every op fails
   `5 NOT_FOUND`; and Enterprise omits the implicit trailing `__name__` field,
   so index JSON copied from Standard-edition docs is wrong. Enterprise also
   unlocks the **Pipelines API** (used in `packages/data` and the arquivo orphan
   sweep), which does **not** run in the emulator — hence the test seams.
2. **The Firestore rulesets are GENERATED — never hand-edit, never deploy.**
   `packages/rules-gen` emits both from the Zod collection metadata. Any
   `*Meta` permission/path, PERM, or validator-whitelist change means running
   **both** `gen:rules` **and** `gen:rules:e2e` (each writes one file) and
   refreshing the two vitest snapshots in `packages/rules-gen/src/__snapshots__/`.
   `ci-rules.yml` drift-checks both rulesets *and* diffs both snapshots, so
   regenerating only one reds CI. `firestore.rules` = production;
   `firestore.e2e.rules` = staging + the emulator lane, and it opens every
   `e2e_`-prefixed collection so it must **never** reach production. Deploying
   rules is a manual, coordinated human step: **agents never run
   `firebase deploy`.** See `packages/rules-gen/README.md`.
3. **Codegen is minimal — exactly two generators.** The rulesets above (ADR
   0003) and the NF-e XSD→TypeScript types (`gen:nfe-types` in
   `packages/integrations/nfe` → **committed** files under `generated/`, ADR
   0004 — never hand-edit those). Form widgets, query builders, cascade and JSON
   converters are all manual TS.
4. **Emulators only in named carve-outs.** Default target is the staging
   Firebase project (`FIREBASE_PROJECT_ID`; the carve-outs point the same var at
   the offline `demo-erp`), with seed/teardown in `tools/test-fixtures`. The
   carve-outs are `ci-storage.yml`, `ci-rules.yml`, `ci-mercado-livre.yml`
   (**two** configs: `firebase.mercado-livre.json`, firestore only, for every
   `apps/mercado-livre/**/*.firestore.test.ts` — the lane where the ML backend
   meets a real Firestore; and `firebase.mercado-livre.tasks.json`,
   firestore+functions+tasks, which serves the ML functions artifact so
   `*.tasks.test.ts` can drive receiver → enqueue → the real `onTaskDispatched`
   → Firestore), and `e2e-emulator.yml`
   (`firebase.e2e.json`, auth+firestore+storage+functions), which runs **every**
   `*.emulator.e2e.spec.ts` — six today. Every other e2e spec hits staging. Do
   **not** add a local-dev emulator mode: `NEXT_PUBLIC_USE_FIREBASE_EMULATOR`
   exists for that CI lane only and is off by default.
5. **`apps/web` is client-first.** Default to `'use client'` — the ERP is behind
   auth, no SEO. Server Components, Server Actions, route handlers and
   **middleware** need PR justification; the one standing exception is
   `app/layout.tsx`, which must stay a Server Component because Next requires
   `export const metadata` there. **No app has a `middleware.ts`** — the auth
   guard is `useRequireAuth()` and security lives in Firestore rules. Server
   compute belongs in the API-only sibling apps and `apps/functions`, never in
   `apps/web`. See `apps/web/CLAUDE.md`.
6. **No generic `catch`.** Narrow with `err instanceof <SpecificError>`
   (`FirebaseError`, `ZodError`, an in-repo class) and `throw err` for anything
   else. `err instanceof Error` does **not** count — it is the parent of every
   exception. ESLint blocks the mechanical part (`no-empty` + two
   `no-restricted-syntax` selectors); which class sits on the RHS is convention.
   ⚠️ Flat config **replaces** a rule by name instead of merging, so a workspace
   that redeclares `no-restricted-syntax` drops the base selectors. Five apps
   re-spread them; **`apps/nfe`** and **`packages/integrations/nfe`**
   deliberately opt out (the nfe package via an explicit `'no-restricted-syntax': 'off'`
   block) — there the catch rule is OFF and the convention is on you, which is
   exactly where a swallowed SEFAZ error costs most.
7. **Every write can lose a race — decide what happens when yours is the
   loser.** Firestore imposes no ordering: a `merge()`/`update()` lands whenever
   it arrives, and `runTransaction`'s OCC retries the callback but does **not**
   re-derive anything captured in the closure, so a value read before an `await`
   is re-applied verbatim over the winner. A second writer is always plausible
   here — provider webhooks arrive out of order, the notification sweep re-drives
   hours-old payloads through the same handler as a fresh task, Cloud Tasks
   retries do the same, a trigger races the client write that fired it, and the
   ERP is multi-user (two operators, two tabs). ⚠️ **The legacy Flutter app is NOT
   one of them** — see rule 8; it never writes a document this app writes, and
   after the cutover this app is the *sole* writer of the real data, which makes a
   lost update here unattributable and unrecoverable rather than less likely. Pick
   the cheapest tier that holds. **(0) Make the race impossible** —
   `FieldValue.increment`/`maximum`/`minimum`, or a deterministic doc id from
   `event.id`; nothing to compare, nothing to drop. **(1) Native precondition** —
   `ref.update(patch, { lastUpdateTime: snap.updateTime })` (Admin only) when the
   patch is derived from a doc you just read; a concurrent change fails
   `FAILED_PRECONDITION` instead of silently losing. **(2) Event-clock
   watermark** — for out-of-order provider events, re-read inside a transaction,
   compare stored against incoming, drop when not fresher, and **always advance
   the watermark on the write that wins** (a watermark that is never advanced is
   a guard that never rejects anything). **(3) Tell the human** — an interactive
   edit that loses raises a conflict, never a silent drop. Re-checking a
   predicate against a binding read *outside* the transaction is not a guard:
   re-derive it from the `tx.get` result. ⚠️ The stamps are **not
   interchangeable** — `ultimaModificacao` is µs on pedido/pagamento/produto but
   **ms** on the ML links, and `historicoFtIni.data` is ms while
   `historicoEstadoPedido.data` is µs, so a cross-unit comparison is a guard that
   never fires. See ADR 0011. ⚠️ There is deliberately **no lint rule** for this —
   the property is semantic and every syntactic proxy was measured and rejected
   (#776). The backstop is
   `packages/config-eslint/rules/firestore-transaction-inventory.test.js`: every
   source file running a `runTransaction` is inventoried with its class (**A**
   self-contained · **B** outside decision + a named guard · **C** network I/O in
   the window), and a new or renamed call site reds CI until it says which it is.
   A class-B/C site with no guard is a finding, not an inventory line.
8. **The production data has not moved yet — everything here runs on staging.**
   The real data still sits in the legacy Flutter project on Firestore
   **Standard**, where the Flutter app is its sole live writer. It moves exactly
   once, in a coordinated window, into a **new project on Enterprise with its own
   billing** — phase order, what an export silently leaves behind, and the
   rollback are ADR 0013. ⚠️ **There is no dual run, and there never will be one.**
   The two apps never share a document: Flutter writes only the legacy project,
   this repo writes only staging. The cutover is one switch — the data moves, the
   `needs-migration-window` queue is worked through, and the legacy app is turned
   **off** in favour of this one. What *does* survive it is the legacy **data**:
   the export carries legacy field names, wire-format enums, unnormalised phones,
   bare outerRefs and rows these schemas do not model, so read-tolerance for
   legacy shapes stays mandatory — that is a fact about the **corpus**, never
   about a second live writer. **Agents never run any of it.** What this means while
   you work: anything your change needs *done* to real data or real
   infrastructure is not yours to do, and is not a TODO — **surface it and
   stop.** Backfills, seed imports, index/rule/TTL deploys, claim re-mints, URL
   rewrites, provider webhook re-registration, secret re-creation: all of it
   belongs to that window, and a run done earlier is superseded by the legacy
   app's own later writes — it is the sole live writer on the *source* project
   until the window switches it off (#869 is the worked example). Say what needs
   running and why it cannot happen now, **ask whether to open the tracking
   issue, and open it only once you have a yes** — the migration queue is
   curated, not a place agents append to unasked. When approved, label it
   `needs-migration-window` plus a `task:` label (usually `ops-deploy`), and link
   it from **#1208** — the tracker that folds every window *operation* into one
   ordered runbook in ADR 0013 phase order. Match the shape its steps use: why
   the timing is load-bearing, the exact commands, how you verify it worked. The
   worked examples stay readable, now closed as duplicates of that tracker —
   **#899**–**#908** deploy-shaped, **#869** backfill-shaped. ⚠️ What is still
   *open* on the label is deliberately **not** window work: code that must merge
   first (#96, #173, #829) and decisions that gate the day (#1115, #163). So the
   label is no longer the checklist — if yours is something to *run*, it is a
   phase step in #1208. ⚠️ A Firestore **import fires no Cloud Functions
   triggers** — nothing is recomputed on arrival, so any state a trigger would
   derive must already be in the export.

## Layout

**apps/** — dev port in parens, all Next.js unless noted.

- `web` (:3000) — internal ERP UI, client-first. Only app with Playwright e2e.
- `integrations` (:3001) — generic webhook/OAuth scaffolding; per-channel routes
  have moved out to their own apps.
- `webchat` (:3002) static-export chat widget · `docs` (:3003) Astro Starlight
  (hosts the ADRs) · `example` OSS demo — **not** Next either, a plain `tsx`
  script: `pnpm --filter @delfrance/example demo`, no dev server.
- `nfe` (:3004) · `melhor-envio` (:3005) · `mercado-livre` (:3006) ·
  `mercado-pago` (:3007) · `whatsapp` (:3008) — API-only App Hosting backends,
  **one deployable per channel**, each importing its logic from the matching
  `packages/integrations/<channel>`.
- `functions` — **not** a Next app: gen2 Cloud Functions, codebase `storage`.

`apps/{nfe,mercado-livre,mercado-pago,whatsapp}/functions/` are **nested**
Functions codebases deployed via `firebase.<name>.deploy.json`. They are **not**
pnpm workspace members — the parent app's tsconfig/eslint/vitest cover them.

**packages/** — `schemas` (Zod schemas + collection metadata, **the** source of
truth) · `data` (`defineCollection<T>`, cascade) · `ui` (Mantine theme +
`TableView`/`ObjectView` derived from the schemas) · `core` · `auth` ·
`storage` · `plugin-sdk` · `rules-gen` · `config-{eslint,tsconfig,vitest}` ·
`ai` (the shared model runtime — ⚠️ its ROOT entry is browser-safe because
`apps/web` reaches it transitively, so `@google/genai` and `firebase-admin` may
be imported only behind `./admin`; enforced by
`packages/config-eslint/rules/ai-root-entry-browser-safe.test.js`, because
breaking it fails nothing) · `integrations/<channel>` — **five packages, all
implemented**: nfe, mercado-livre, mercado-pago, freight-br, whatsapp-cloud-api.
⚠️ The five throw-only marketplace scaffolds (shopee, magalu, amazon-sp-api,
facebook, loja-integrada) were **deleted** in #815: they existed only to typecheck
against `MarketplaceChannel`, and had no importer anywhere. **That contract is
gone too** — a marketplace is declared by `MARKETPLACE_TIPO_CAPS`
(`packages/schemas/src/shared/marketplace.ts`, the `FREIGHT_TIPO_CAPS` shape) and
implemented as one App Hosting backend per channel; its shared data shapes live in
`@delfrance/core/marketplace`. `packages/core/src/plugins` keeps exactly three
contracts (tax/invoice/payment), and nothing in-tree registers at boot. ADR 0015 +
the `marketplace-integration` skill; guarded by
`packages/config-eslint/rules/marketplace-contract-removed.test.js`, because
re-adding the interface fails nothing.

**tools/** — `test-fixtures` (Admin SDK seed/teardown, `create-super-user`) ·
`migrations` · `cmun-table` (moves the legacy `CMUN` CEP-faixa → IBGE table
between projects, #785) · `deploy-env` (**the** source of truth for which `.env*`
files a Functions deploy artifact may contain — shared by all five
`prepare-deploy.mjs`, and what keeps `.env.secrets` out of `gcf-sources-*`).
Firebase configs: `firebase.json` (prod), `firebase.staging.json`,
emulator-only `firebase.{functions,rules,e2e}.json` plus
`firebase.mercado-livre{,.tasks}.json`, and five deploy-isolated
`firebase.<codebase>.deploy.json`. ⚠️ **Three** `firebase.mercado-livre*.json`
now sit one dot apart, and only one of them deploys:
`firebase.mercado-livre.json` (emulator, firestore only) and
`firebase.mercado-livre.tasks.json` (emulator, firestore+functions+tasks) vs
`firebase.mercado-livre.deploy.json` (the ML functions codebase). Read the whole
filename before any deploy. The two emulator ones are safe by construction —
neither declares a rules or indexes path, and the `.tasks` one's `functions.source`
points at the **generated** `.deploy/mercado-livre-functions` artifact, which
exists only after `prepare-deploy.mjs` runs — so a stray deploy against either
can push nothing.

## Common commands

```bash
pnpm install                                # per worktree too; apps read ../../.env.local
pnpm --filter @delfrance/web dev            # ONE app — prefer this
pnpm dev                                    # WARNING: 9 dev servers, :3000-:3008
pnpm turbo run lint typecheck               # before commits
pnpm format:check                           # a CI gate; `pnpm format` fixes
pnpm turbo run test
pnpm --filter @delfrance/rules-gen gen:rules   # + gen:rules:e2e after any *Meta/PERM change
```

## When making changes

- **New schema** → `packages/schemas/src/<domain>.ts`, barrel-exported from
  `src/index.ts` and registered in `src/registry.ts` (`ALL_DOMAINS`) —
  `registry.test.ts` fails if you forget. Then regenerate both rulesets (rule 2).
- **Optional Firestore fields** → `.nullable().default(null)`. Never
  `.optional()` without a `.nullable()` in the chain: the Firebase SDK rejects
  `undefined` in `addDoc`/`setDoc`. `.nullable().optional()` is correct for
  server-stamped fields the client never writes. Enforced by
  `delfrance/no-optional-without-nullable`.
- **Porting a query from `.old/`? Re-derive it, don't transcribe it.** The
  Flutter app ran on Firestore **Standard**, and several of its query shapes are
  workarounds for limits that no longer exist — above all the old ban on
  inequality filters over two different fields, which forced cursor tricks like
  `TabelaoCmun`'s (a `startAt` standing in for the second bound; it was **inert**,
  so a value landing in a gap silently matched the WRONG row — #785). Always ask
  what the query *means* and how you would express it today.
  ⚠️ Then check that answer against rule 1, because a modern shape is **not**
  automatically cheaper. A second inequality is a *post-filter*: Firestore's docs
  are explicit that the extra constraint "does not reduce the number of index
  entries scanned", and Enterprise bills **data scanned**. #785 measured it and
  kept the single-inequality shape — `where('cepFinal','>=',n).orderBy('cepFinal').limit(1)`
  with the lower bound checked in code reads ONE document; the "obvious"
  two-inequality version scans half the table on a hit and the entire tail on a
  miss. Cheapest ≠ most readable: measure the scan, not the syntax.
- **New collection** → `defineCollection({ path, schema })`. Partial updates go
  through the handle's `merge()`, never `setDoc(ref, patch, { merge: true })` on
  a converted ref — the converter full-parses the patch and the merge mask then
  overwrites stored sibling fields.
- **Repeated read of a slow-changing doc/query** on a server surface →
  `@delfrance/data/admin/cache` (`createReadCache` / `createCachedDocReader`)
  via the `firestore-read-cache` skill; TTL is mandatory and *is* the staleness
  bound. **Never** cache a `tx.get()`, an OAuth token, or a value you write back.
- **New CRUD screen** (`TableView` + `ObjectView`) → the `schema-driven-crud`
  skill. **New page or form in `apps/web`** → `apps/web/CLAUDE.md`.
- **New channel webhook or OAuth callback** → its **own app**,
  `apps/<channel>/app/api/{webhooks,oauth}/<channel>/…` — one App Hosting
  backend per channel. Never in `apps/web`, and no longer in
  `apps/integrations`. Heavy work dispatches to a Cloud Function; the route
  handler responds 200 fast. For an **inbound notification receiver**, build on
  the shared pipeline (`defineNotificationPipeline` in
  `@delfrance/data/admin/notifications`) via the `webhook-notifications` skill —
  never hand-roll the persistence/retry/sweep triad again.
- **A whole new MARKETPLACE channel** (Shopee, Magalu, Amazon…) → the
  `marketplace-integration` skill. Docs-first: read the provider's own reference,
  fill its `MARKETPLACE_TIPO_CAPS` row (capability fields are three-valued —
  `'desconhecido'` is the honest default, never a guessed `false`), generate the
  master plan from that row, then plan each step as you reach it. ⚠️ Mercado Livre
  is EVIDENCE, not a template: the `orderML` pedido mirror, User Products,
  `tokenDuravel` and its unsigned webhook are ML-only, and a capability ML LACKS
  (virtual kits) is not one the domain lacks.
- **Does your change need something *run* against production data or infra?**
  Don't do it and don't leave a TODO — surface it, **ask whether to open the
  tracking issue**, and open it only on a yes. Then label it
  **`needs-migration-window`** (plus a `task:` label, usually `ops-deploy`), link
  it from the PR **and from #1208** — the one ordered cutover runbook — and say
  in the issue *why earlier is wrong*. Shape: the closed-but-readable #899–#908
  for a deploy, #869 for a backfill. Rule 8 / ADR 0013.
- **Re-implementing a rule that already runs on another surface? Extract it to
  `packages/schemas` instead.** `apps/web` has no dependency edge to any `apps/*`
  and none is possible, so a browser surface that needs a server rule has exactly
  two options: share it, or write it twice. **Pure and total — no clock, no
  network, no Firestore — is the test for whether it can move**, and it is what
  `precisaConsultarModeracao` (#1239), `clienteIdentity.ts` (#786) and
  `conversa.ts`'s `ehEstadoDeSaida` all did. ⚠️ **A comment asserting what the
  OTHER copy does is the smell**, and the copies drift *toward plausible*, so
  they read correct while disagreeing: #1369 shipped a size-chart panel whose
  header called itself a "line-for-line mirror" and which had already drifted in
  two places — a `value_id` short-circuit where the resolver ORs, and a fallback
  keyed on the filtered attribute list where the resolver keys on the raw one.
  Both were green, both were commented, and one painted a ✗ on a row the same
  module labelled *vincula*. Reviewers cannot diff two files by eye; the compiler
  can, once there is only one.
- **Changing the shape of data that already exists? Write a one-time migration
  script — do not migrate gradually.** A one-time `tools/migrations` script beats
  every incremental alternative here: dual-shape reads, a compat/fallback branch,
  lazy backfill-on-read, a derived field kept in sync by a trigger. All of those
  buy one thing — *surviving indefinitely without a cutover* — and there **is** a
  cutover (rule 8), so they pay for something already bought and leave permanent
  compat code nobody deletes. #869 worked this exact trade and rejected the
  derived-field version: schema change → both rulesets regenerate → both
  snapshots refresh → a sync trigger → a new index → every query site touched →
  *and it still needs a backfill*. The script is strictly less machinery. Follow
  the `tools/migrations` contract (`README.md`): `--project` required and matched
  against the service account, dry-run the default, JSONL log in `out/`, a pure
  `transform.ts` with unit tests. **Idempotent and re-runnable is not optional** —
  the legacy app keeps writing the *source* project until the window switches it
  off, so a run before the window is partially superseded and the authoritative
  run is the one *inside* it. ⚠️ **Staging data does not
  need to migrate.** The window moves *production* data; staging is disposable and
  re-seedable from `tools/test-fixtures`, so a script only has to be correct
  against production shapes — if staging is easier to re-seed than to fix, re-seed
  it, and never hold a design hostage to staging rows. A staging run is a
  **rehearsal** (dry-run counts, then a clean second pass as the idempotence
  check), never a data-preservation goal. ⚠️ **The script is not done until its
  issue exists** — a merged script nobody runs is a no-op.
- **Writing something that decides whether two values are "the same"? Test the
  fold's SCOPE, not just that it applies.** A *fold* is any transform whose
  output drives an equality, a `Set`/`Map` key or a diff — `normalizeLoose`, the
  `@delfrance/core/decimal` helpers, `deepEqual`/`stripNullsDeep`. ⚠️ A test that
  the fold APPLIES cannot show where it STOPS, and the gap is silent: #1372's row
  diff folded `value_name` to a NUMBER, so `'90,5'` ≡ `'90,50'` and `'01'` ≡
  `'1'` — real edits read as "no change", and since `persistProgress` opens with
  `if (!updated) return;` they reached neither Mercado Livre **nor** Firestore,
  behind a 200. **Eight mutation tests passed**; every one asked "does it fold?",
  none asked "does it fold too much?". So write **both**: a pair that must come
  out equal, and a **near-miss** that must stay distinct. Backstopped by
  `packages/config-eslint/rules/equivalence-fold-inventory.test.js` — using one
  of those helpers in a new file reds CI until you say what the fold treats as
  equal, what must stay distinct, and which test pins it. ⚠️ It matches the
  shared helpers only; a hand-rolled
  `a.trim().toLowerCase() === b.trim().toLowerCase()` is invisible to it (the
  wider pattern was measured at ~47 mostly-irrelevant files and rejected), so
  route comparisons through the shared readers.
- **New e2e test** → the **filename suffix picks the lane**, nothing else to
  wire: `.cadastros.e2e.spec.ts` (master data), `.vendas.e2e.spec.ts`
  (sales/fiscal/config), `.emulator.e2e.spec.ts` (offline), `.smoke.spec.ts`.
  **Do not** add an e2e job to `ci.yml`. An e2e spec asserts a **behaviour**,
  never a **deployment state** — a title that explains what is or is not deployed
  rots the moment it is (enforced by `apps/web/e2e/spec-conventions.test.ts`; see
  `apps/web/CLAUDE.md` rule 8).

## Key fixed decisions

- Firebase backend stays. Node >= 22. Zod is the schema source of truth.
- **firebase-admin and firebase-functions are pinned EXACT — `14.2.0` and
  `7.3.2` — in the catalog AND in all five deploy-artifact manifests, and do not
  lower either below admin v14 / functions 7.3.0.** `apps/functions` needs the v8
  Pipelines API + `FieldValue.maximum/minimum` (a downgrade fails typecheck), and
  7.3.0 is the first firebase-functions whose peer range admits
  `firebase-admin@^14` — lowering it breaks every deploy artifact's plain cloud
  `npm install` (`ERESOLVE`), which no CI lane exercises. ⚠️ The pins are **exact
  rather than `^` ranges** because a deploy artifact ships **no lockfile**: every
  `prepare-deploy.mjs` emits `dependencies` verbatim and every
  `firebase.*.deploy.json` sets `ignore: ["node_modules"]`, so the gen2 buildpack
  resolves each spec fresh and a range installs whatever is newest **at deploy
  time** — a version no CI lane ever tested. That is not theoretical:
  `firebase-functions@7.3.2` moved `express` from `^4.21.0` to `^5.2.1` (an
  Express **major**, for CVE remediation) in a **patch** release, so under the old
  `^7.3.0` every function deployed after 2026-07-28 ran Express 5 in production
  while CI still tested Express 4, with no signal anywhere. A bump is now six
  deliberate edits — the catalog plus the five manifests — and
  `packages/config-eslint/rules/runtime-deps-pinned.test.js` fails if they drift
  apart or if either spec regains a range. ⚠️ The `^14` **peerDependencies** in
  `packages/data` and `packages/storage` stay broad; libraries do not pin.
- `next lint` is gone in Next 16 — every lint script is `eslint .`. `@delfrance/config-eslint`
  is split into composable entries: the default export is the framework-agnostic
  core, `./react` adds the `react-hooks` warns (plugin supplied by
  `eslint-config-next`, or registered locally as in `packages/ui`), and
  `typeAware(...)` layers the async-correctness rules scoped to the workspace's
  tsconfig `include`. The 8 Next apps spread base + react + `eslint-config-next`
  + `typeAware(...)` with `prettier` LAST; libraries spread base + `typeAware(scoped)`
  + `prettier`. Only `apps/docs` (Astro) and `packages/config-tsconfig` (JSON-only)
  are not linted.
- **Unused variables fail in BOTH gates, and `warn` gates nothing here.**
  `@typescript-eslint/no-unused-vars` (error, inside `typeAware(...)`) plus
  `noUnusedLocals` in `packages/config-tsconfig/base.json`, with core
  `no-unused-vars` re-enabled for `.js`/`.mjs` only — `typeAware`'s glob is
  TS-only, which would silently exclude every rule and backstop in
  `packages/config-eslint/rules` and the five `prepare-deploy.mjs`. Before #1445
  all three mechanisms were off at once and a dead import was invisible
  repo-wide: #1442 orphaned a `useQuery` import that survived typecheck 28/28,
  lint 30/30 and 3013 web tests. ⚠️ The severity is not cosmetic — **no lint
  script passes `--max-warnings`**, so `turbo run lint` never fails on a
  warning; only `.lintstagedrc.mjs` does, and only for staged files. That is why
  the repo's stated bar is `error` when the pre-existing population is zero and
  `warn` only as a ratchet over a known one. `^_` is the escape hatch.
  Guarded by `rules/unused-vars-enabled.test.js`, because switching any of it
  back off fails nothing.
- Fourteen custom lint rules in `packages/config-eslint/rules/`:
  `default-query-needs-index`, `no-ad-hoc-money-rounding`,
  `no-optional-without-nullable`, `no-client-estado-history-write`,
  `no-env-secrets-access`, `no-hardcoded-gcp-region`,
  `no-unvalidated-response`, `no-focused-test`,
  `require-firestore-database-id` and
  `prefer-schema-enum` (error), `no-inline-admin-collection`,
  `no-lossy-date-parse`, `no-ambient-timezone` and
  `no-error-as-sole-instanceof` (warn). `no-focused-test` bans a committed
  `describe.only`/`it.only`/`test.only`: it does not fail anything, it stops the
  rest of the file running while every reporter still says PASS. Playwright's
  `forbidOnly` defaults to **false** and `apps/web/playwright.config.ts` did not
  set it, so one `.only` in any of the 62 e2e specs took an `E2E gate` check
  green over a suite that had stopped running — the silent-pass class the whole
  `ci-lanes` design exists to prevent. That config now sets
  `forbidOnly: !!process.env.CI`; Vitest's `allowOnly` is safe only by an
  undeclared upstream default. `require-firestore-database-id` bans a call that never
  reaches its database-id argument: Enterprise names the database `default`, not
  the `(default)` sentinel such a call resolves, so the handle fails
  `5 NOT_FOUND` on **every** operation — a convention seven copies of `admin.ts`
  across five codebases were holding by comment alone. ⚠️ It covers **two**
  callees whose id sits at different positions — argument 1 for `getFirestore`,
  argument **2** for `initializeFirestore`, which `apps/web` uses deliberately
  for the IndexedDB persistent cache. A single arity threshold silently exempts
  the second, and `initializeFirestore(app, settings)` is the documented shape
  everywhere outside this repo. `no-unvalidated-response` bans asserting
  a type onto an HTTP response body — `return parsed as T`, `(await res.json())
  as Foo`. Six near-identical clients ended that way, so on any 2xx the caller
  got whatever arrived wearing a type nobody verified, and all three failure
  modes were SILENT: a wrong shape came back cast, an empty body came back as
  `null as T`, and a proxy's HTML came back as `{error: '<html>…'}` — a TRUTHY
  object that sailed through `if (conta)`. That is what reported a mint as
  successful while it had reused two accounts and wiped a credential
  (#1295 → #1302). ⚠️ Both of its shapes additionally require a TRANSPORT call
  (`fetch`/`doFetch`/`fetchImpl`) in an enclosing function, and that qualifier
  is the rule: without it the same checks flag ~120 sites — service-account
  files, fixtures, `sessionStorage`, and every test reading back its own
  `NextResponse` — while `snap.data() as T` on a Firestore snapshot is
  character-for-character the banned shape and perfectly correct. Validate with
  `lerRespostaJson` (`@delfrance/core/wire`), or say `as unknown` and narrow. `no-ambient-timezone` bans reading the
  ambient process timezone on a SERVER surface: `apps/nfe` runs
  `TZ=America/Sao_Paulo` while every other backend is UTC, so the same code
  answers three hours apart depending on which service ran it — and the test
  runner's own third zone hides it. `no-env-secrets-access` bans any literal
  naming `.env.secrets` — the repo's credential template, which nothing automated
  may read; its non-JS half (workflows, firebase configs, shell) is the
  `env-secrets-no-copy` backstop test, since ESLint parses neither.
  `no-hardcoded-gcp-region` bans a bare region id (`us-east1`, `nam5`) as a string
  literal: the region belongs in the environment, read through `requireRegion`
  (`@delfrance/core/region`) or `requireBuildRegion` (`tools/deploy-env`), both of
  which **throw** when it is unset. A hardcoded fallback is how this repo drifted
  into three regions with nothing failing — a function deployed to the wrong region
  deploys fine, and an enqueue against the wrong one is **dropped while the route
  returns 200** (#1108), so the first signal was the inter-region transfer bill.
  Tests and `preflight.mjs`'s `REGIONS_WITHOUT_TASKS` are exempt (both must name a
  region to mean anything); config files legitimately hold the literal, and the
  matching `functions-region-supplied` backstop asserts the inverse there — every
  workflow that builds a functions bundle must SET `FUNCTIONS_REGION`, since a
  missing one now refuses the build. `no-client-estado-history-write` guards
  BOTH server-owned pedido audit trails — `historicoEstadoPedido` and
  `historicoFtIni` — whose sole writer is the `onPedidoChanged` trigger.
  `prefer-schema-enum` is the only **type-aware** one, so it is enabled inside
  `typeAware(...)` rather than the base block: it flags a raw string sitting in
  a position typed as a Zod enum (`estado === 'pago'` → `ESTADO_PEDIDO.pago`).
  An enum opts in by gaining a companion
  `as const satisfies Record<string, T>` constant — **every one has one**
  (#699). It identifies an enum by the **declaration** behind the literal's
  position — a Zod property names its schema variable, an annotation names its
  type — never by the member set, which is not an identity: `'1' | '2'` is both
  `IndIncentivo` and the NF-e engine's `TpAmb`, and matching on the set once
  rewrote `tpImp: '1'` (DANFE layout) to `MOD_BCST.listaNegativa`.
- Firebase App Hosting deploys every Next app **except `webchat`** (static
  export served by `firebase.json` hosting — 7 `apphosting.yaml` files, 8 Next
  apps); heavy work goes to Cloud Functions. `apps/portal/` does NOT exist —
  public pages are deferred. ⚠️ An `apphosting.yaml` carries only `runConfig` +
  `env` — no build-root and no build command — so anything the **buildpack**
  gets wrong has to be fixed in the manifest itself (see the `next` pin under
  the catalog bullet below).
- **Shared dependency versions live in the pnpm `catalog:`**
  (`pnpm-workspace.yaml`): a dep declared by 2+ workspace manifests is
  cataloged and referenced as `catalog:`; single-consumer deps stay literal.
  `catalogMode: strict` routes `pnpm add` through the catalog. **Five** things
  NEVER use `catalog:`, and all five are ONE rule — an **external resolver
  reads the manifest without our lockfile or workspace context**: the 4 nested
  `apps/*/functions` manifests (not workspace members), `apps/functions`'
  runtime `dependencies` (every `prepare-deploy.mjs` copies `dependencies`
  verbatim into an artifact that plain cloud `npm install` must resolve), all
  `peerDependencies` (libraries keep broad ranges), `workspace:*` specs, and
  **`next` in the 7 `apps/*/package.json` that have an `apphosting.yaml`** —
  an exact literal there, never `catalog:` and never a `^` range. The App
  Hosting buildpack `google.nodejs.firebasenextjs` derives `FRAMEWORK_VERSION`
  from a lockfile it cannot read (`pnpm-lock.yaml`), silently falls back to the
  RAW manifest string, and `@apphosting/adapter-nextjs` hands that to
  `semver.satisfies(spec, SAFE_NEXTJS_VERSIONS)` — which rejects anything
  unparseable as a *version*, killing the build with `CVE-2025-55182:
  Vulnerable Next version catalog: detected. Deployment blocked.` A **false
  positive** (16.2.6 is patched, `>=16.1.0`), and unfixable from outside the
  manifest: the buildpack `Override`s `FRAMEWORK_VERSION` *after* computing it,
  so setting the var in `apphosting.yaml` does nothing, and `apphosting.yaml`
  has no build-root knob to aim at a `pnpm deploy` artifact. ⚠️ PR #410 already
  fixed this once (with `^16.2.6`); the catalog migration silently undid it and
  nothing failed until a human tried to deploy months later —
  `packages/config-eslint/rules/apphosting-next-pinned.test.js` is that missing
  signal. ⚠️ Those five artifact
  `dependencies` blocks are literal **and**, for `firebase-admin` +
  `firebase-functions`, **exact** — no lockfile reaches the cloud, so a range
  there ships an untested version (see the firebase pins above);
  `packages/config-eslint/rules/runtime-deps-pinned.test.js` enforces it.
  Three high-blast-radius deps stay pinned **exact** in the catalog for the same
  "one deliberate edit" reason — `next` (`16.2.6`), `firebase-admin` (`14.2.0`)
  and `firebase-functions` (`7.3.2`). ⚠️ `next` propagates by **copy**, not by
  reference: the catalog is still where a bump *starts*, but it is **8
  deliberate edits** — the catalog plus the 7 App Hosting app manifests — and
  the guard above fails on drift. Its only remaining `catalog:` consumers are
  `apps/webchat` (static export, no buildpack) and `packages/ui`'s
  devDependency, which makes them load-bearing: literalise BOTH and
  `cleanupUnusedCatalogs: true` deletes `next: 16.2.6` from the catalog on the
  next install. Do not bump it with `pnpm add` — under `catalogMode: strict`
  that rewrites the spec back to `catalog:`, the exact string that blocks the
  deploy. **`packageManager` is the sole authority for pnpm *in CI*** — corepack
  honours it over any activated default, so CI runs only `corepack enable`
  and never pins a version. Do not re-add a `corepack prepare pnpm@x.y.z`:
  it is silently overridden, which is exactly how the workflows drifted to
  declaring a version they never used (#612). ⚠️ **App Hosting does NOT read
  it.** `google.nodejs.pnpm`'s `detectPNPMVersion` gives **`engines.pnpm`
  precedence over `packageManager`**, and falls back to a pinned/`latest`
  version only when BOTH are empty — so CI and the cloud resolve pnpm through
  *different fields*, and `engines.pnpm` must be an **exact** version **equal
  to** `packageManager`'s, never a range. Same failure class as the `next` pin
  above: no lockfile reaches the cloud, so a range is resolved against the npm
  registry at DEPLOY time to the highest published match — which includes a
  version published under a **non-`latest` dist-tag whose GitHub release does
  not exist yet**. On 2026-08-24 `>=11.0.0` resolved to `11.24.0` (dist-tag
  `next-11`; npm `latest` was `11.23.0`) and the staging deploy died fetching
  `pnpm-linux-x64.tar.gz` — **HTTP 404**, inside the pnpm buildpack, before a
  line of app code was built. Nothing in the repo had changed, and nothing
  changes when it heals: the coin flip belongs to pnpm's publish schedule.
  Guarded by `packages/config-eslint/rules/apphosting-pnpm-pinned.test.js`.
  ⚠️ `engines.node` deliberately stays a **range** — pnpm hard-fails an install
  outright (`ERR_PNPM_UNSUPPORTED_ENGINE`) when the running version does not
  satisfy `engines`, and the deployed runtime comes from
  `GOOGLE_RUNTIME_VERSION` (24.19.0 today), not from that field.
- **Turbo is the only test aggregator — there is no root vitest config.** Each
  workspace owns a `vitest.config.ts` and a `test` script; `pnpm test`
  (= `turbo run test`) fans out across them with caching, and `ci.yml` filters
  out the eight workspaces needing live creds or emulators. Do not re-add a
  `vitest.workspace.ts`: Vitest 4 **removed** workspace files, so the one that
  used to sit at the root was inert — `vitest --project <name>` matched nothing
  and a bare root `vitest` just globbed the repo with the root config, failing on
  every app-level path alias. A root `projects: [...]` config would "work" but is
  a trap: it runs the live-credential suites turbo's filters exist to skip.
