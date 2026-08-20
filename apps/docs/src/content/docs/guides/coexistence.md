---
title: Legacy data compatibility
description: Why this app mirrors the Flutter ERP's collection paths, field names and wire-format enums — the migrated corpus, not a second live writer.
---

This Next.js app **replaces** the Delfrance Flutter ERP. It does not run beside it.

⚠️ **There is no dual run, and there never will be one.** The two apps never read
or write the same document at any point:

| Project | Firestore | Written by |
|---|---|---|
| legacy prod | Standard | the Flutter app — its sole live writer |
| staging | Enterprise | this repo (the CI/e2e target) |
| new prod | Enterprise | this repo, **after** the cutover — Flutter is off by then |

The cutover is one switch: production data moves into the new Enterprise project,
the `needs-migration-window` issue queue is worked through, and the legacy app is
turned off in favour of this one. Phase order and rollback are
[ADR 0013](/adr/0013-firebase-project-migration/).

## What legacy compatibility actually buys

The **data** outlives the app that wrote it. Every rule below exists so this app
reads the migrated corpus natively — never because a second writer is racing it.
Read them all as statements about **stored documents**, not about a running app.

1. **Collection paths are identical.** `packages/schemas/src/<domain>.ts` mirrors the Flutter `@EasyFirebase(collectionName: ...)`, so an imported document lands where this app already looks for it.
2. **Field names are identical.** `cpf_cnpj`, `data_cadastro`, `mid`, `forma_de_pagamento` — the stored wire format is preserved (snake_case where the Flutter side used snake_case, even if it offends the JS style).
3. **Wire-format enums.** Int-coded enums (`STATUS_PAGAMENTO`, `INTEGRACAO_PEDIDO`, `EstadoConversa`) keep the same integer values; string-coded ones (`origem`, `tipo` for cliente) keep their string codes. A stored `2` has to keep meaning what it meant.
4. **Schemas soft-parse on read.** The corpus contains fields these schemas do not model — the Flutter app wrote them and nothing has removed them. Reads pass them through unchanged (`.passthrough()`) instead of failing, and the schema simply does not surface them to the UI.
5. **Server-managed fields are pass-through.** Vector embeddings (`nome_embedding`, `telefone_embedding`), Cloud Function side-effects and similar never round-trip through this app.
6. **Legacy-shaped values survive the import.** Unnormalised 10/11-digit phones, bare `depositos/<id>` outerRefs, `historicoEstoque` rows with no `movimento`, subcollections `ALL_DOMAINS` does not register. Readers tolerate them; where that tolerance is not wanted long-term, a one-time `tools/migrations` script runs inside the cutover window.

## Permission claims

Custom claims encoded as BigInt strings:

```ts
hasPerm(userClaims.permissions, PERM.cliente.read);  // bool
```

The legacy ruleset encoded them the same way, and Auth users migrate with their
claims intact, so the bit layout has to match what was minted. Bits are grouped
per domain in `packages/auth/src/permissions.ts`; adding one is still a
coordination point. `packages/rules-gen/src/legacyCoverage.ts` checks that the
generated ruleset does not drop access the legacy one granted — migrated users
must keep the access they had.

## Rules ownership

Both rulesets are **generated in this repo** from the Zod collection metadata by
`packages/rules-gen` (ADR 0003) — `firestore.rules` for production and
`firestore.e2e.rules` for staging plus the emulator lane. Never hand-edit either;
see the root `CLAUDE.md`, Critical rule 2.

## After the cutover

Once the legacy app is off, the compatibility surface above stops being a
constraint on **writes** and becomes a property of the **stored history**:

1. Retire the client grants that existed only to keep the legacy app working (#829).
2. Tighten collections to `serverOwned` where the only reason they stayed client-writable was the legacy client.
3. Migrate or drop the legacy shapes still tolerated on read, and delete fields this app no longer authors (denormalisations, cascade triggers).

The data side of that — moving production into the new Enterprise project, and
the queue of one-time migration scripts that runs inside the same window — is
[ADR 0013](/adr/0013-firebase-project-migration/).
