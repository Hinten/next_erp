---
title: 0016 — Single tenant, and the vestigial grupoEconomico surface stays
description: Why multi-tenancy is not being designed or implemented, why the residual grupoEconomico claim, schema and rule block are deliberately left in place rather than removed, and what a future second tenant would have to resolve.
---

## Context

The legacy Flutter ERP was multi-tenant, but **not** through a per-document
field. Isolation was **physical**: a central auth database held a
`GrupoEconomico` directory (`nome`, `databases`, `databaseMap`, `users`) mapping
each user to a tenant and to that tenant's **own Firebase project**; the client
resolved the user's grupo, then OIDC-federated into the tenant project
(`OAuthProvider('oidc.auth_oidc')` → `signInWithCredential`) and read perms from
`Usuario` + `Cargo` **inside that database**. No business query ever carried a
`grupoEconomico == X` filter, because each tenant's data lived somewhere else.
That model had a known hole: a user mapping to more than one grupo hit a hard
`UnimplementedError('Implementar seleção de grupo econômico')` — **multi-group
selection was never implemented**.

The port started down a **different** road: a `grupoEconomico` custom claim plus
a mandatory `grupoEconomico` field on every document, filtered in queries and in
Firestore rules. The User+Cargo review PR removed that mandatory field from the
schemas, forms and endpoints it had just introduced, on the grounds that the
approach was being replaced — and nothing replaced it. Issue
[#14](https://github.com/Hinten/next_erp/issues/14) has held that gap open since.

**What is actually left in the tree (measured 2026-09-07).** `grupoEconomico`
survives in 28 files, and every functional one of them is in one of four places:

| Where | What it does |
| --- | --- |
| `packages/core/src/tenant/` | `grupoEconomicoSchema`, `databaseMapSchema`, `GRUPO_ECONOMICO_COLLECTION_PATH` |
| `apps/web` | `useTenant()` reads the claim · `useGrupoEconomico()` subscribes to `grupoEconomico/<claim>` · `TenantBadge` renders `data.nome` · the configurações card |
| `packages/rules-gen/src/registry.ts` | one `EXTRA_MATCH_BLOCKS` entry, emitted into **both** rulesets: `allow read` on your own tenant doc, `isSuperUser()` or claim-matches-id |
| `tools/test-fixtures` + e2e | the optional `--grupo` claim in `create-super-user` / `grant-all-perms`, and the `grupoEconomico: 'seed'` claim the e2e `globalSetup` grants |

And what is **not** there:

- **Zero** business queries filter by tenant. `cargos` and `usuarios` have been
  unfiltered since the review PR, and the `callerGE` check the admin users
  endpoints (`apps/integrations/app/api/admin/users/*`) once had is gone from the
  tree entirely.
- `databaseMap` is parsed and **never acted on** — the module says so in a
  comment: "the Next.js app reads it but does not act on it (single-database
  mode for now)".
- No `middleware.ts` anywhere, no tenant scoping outside the one rule block.

So the whole live cost of "multi-tenancy" today is **a badge in the header and
one self-read rule**. There is one tenant, Delfrance, and no second one on the
roadmap.

## Decision

**The ERP is single-tenant. Multi-tenancy is not being designed, and #14 is
closed as won't-fix.**

Two halves, and the second is the one that is easy to get wrong:

1. **No tenant scoping is added.** No per-document field, no path prefix, no
   second database, no tenant filter on `cargos`/`usuarios` or anywhere else.
   Access control is **permission bits in Firestore rules** and nothing more.
   The unfiltered queries are now a decision, not an outstanding gap.
2. **The residual `grupoEconomico` surface is left exactly as it is** — not
   removed, not extended. It stays vestigial on purpose.

Leaving it is deliberate because **removing it is not free and buys nothing**:

- It is an **ordered** four-step removal, and the order is load-bearing: the
  claim is what *enables* the rule block, so dropping the claim while
  `match /grupoEconomico/{grupoId}` still stands leaves **nobody** able to read
  their own tenant doc.
- The last step regenerates **both** rulesets and refreshes **both** snapshots
  (critical rule 2), rewrites five tests that pin the current behaviour
  (`packages/rules-gen/test/{firestore,superuser,coverage}.rules.test.ts`,
  `packages/core/src/tenant/tenant.test.ts`,
  `apps/web/lib/data/collectionCoverage.test.ts`), removes the sole
  `EXTRA_MATCH_BLOCK` exception in the collection-coverage test, and drops the
  `topLevel` collision guard `emit.ts` derives from those blocks — and it still
  needs a staging rules deploy at the end.
- **The migrated corpus will carry these documents anyway.** Rule 8 / ADR 0013:
  what survives the cutover is the legacy **data**, and the legacy data has real
  `grupoEconomico` documents in the Flutter shape. Read-tolerance for
  `databases` / `databaseMap` / `users` stays mandatory while the collection
  exists, so `grupoEconomicoSchema` earns its keep with or without this decision.

## Consequences

- **`apps/web/CLAUDE.md` rule 6 was false and is corrected in this change.** It
  read "`useTenant()` reads `grupoEconomico` from custom claims. All queries
  filter by it." The second sentence has not been true since the review PR, and
  a reader following it would have added a filter no rule enforces and no other
  query carries.
- A `grupoEconomico` claim is still needed for the badge to resolve. Set it with
  `pnpm create-super-user <email> --grupo <id>` or `grant-all-perms --grupo`; a
  session without it simply renders no badge (`useGrupoEconomico` returns
  `data: null`), which is not an error state.
- **The accepted risk, stated plainly:** with one tenant, an over-broad
  permission bit leaks nothing. The day a second tenant exists, **every query in
  the app is a cross-tenant leak** — there is no field, no prefix and no rule
  standing between them. That is the whole price of this ADR, and it is only
  payable in a future where the premise ("one tenant") has already changed.
- Therefore: **a second tenant requires a new ADR before a line of code**, not a
  patch on top of this one. That design must resolve two things the legacy model
  never did — how a user belonging to more than one grupo picks one (legacy
  hard-threw), and how tenancy composes with the `default`-named Enterprise
  database and the generated rulesets (critical rules 1 and 2). The legacy
  database-per-tenant flow in `.old/lib/user/providers/auth.dart` and
  `.old/packages/grupo_economico/lib/src/models.dart` is the reference for how it
  used to work, **not** a template for how it should work here.

## Alternatives considered

- **Per-document `grupoEconomico` field + a rules filter** (the abandoned port
  approach) → rejected. It taxes every collection with an extra indexed field and
  an extra `where` on every query, and Firestore Enterprise bills **data
  scanned** (critical rule 1) — a permanent cost across the whole schema to
  separate a set of size one.
- **Path prefix `tenants/{tenantId}/...`** → rejected. Rewrites every
  `collectionPath` in `packages/schemas`, every generated rule, and every
  `defineCollection` call site, for the same set of size one. Same reason
  `packages/schemas/src/types.ts` documents field-based tenancy rather than
  prefixes.
- **Database-per-tenant (the legacy model)** → rejected *for now*, and the
  closest thing to a real future answer. It needs a central auth project, an OIDC
  provider, per-tenant Firebase configs and a federation step at login — genuine
  infrastructure standing up for a tenant that does not exist. Revisit only when
  one does.
- **Removing the residual surface now** (finishing #14's cleanup without
  replacing the model) → rejected. It is the ordered four-step removal above plus
  two ruleset regens, two snapshot refreshes, five test rewrites and a staging
  rules deploy, in exchange for deleting a badge — and the migrated corpus keeps
  the documents regardless.

## Status

Accepted. Supersedes the multi-tenancy intent recorded in issue #14 (closed
won't-fix). Related: ADR 0003 (rules generator — the block lives in
`EXTRA_MATCH_BLOCKS`), ADR 0013 (the corpus that arrives carrying these
documents).
