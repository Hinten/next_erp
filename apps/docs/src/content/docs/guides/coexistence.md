---
title: Coexisting with the Flutter app
description: How Next.js and Flutter share the same Firestore during the migration.
---

Delfrance's production app is currently Flutter; this Next.js rewrite is replacing it incrementally. Both apps run against the **same Firebase project** during the migration window. This guide explains how that's safe.

## Shared substrate

| Layer | Owner |
|---|---|
| Firestore documents | both apps read/write the same docs |
| Firestore rules | Flutter app deploys today; Next.js inherits the rules |
| Cloud Functions (Python) | unchanged |
| Cloud Functions (Node) | unchanged |
| Firebase Auth users | unchanged; same custom claims |

## How collisions are avoided

1. **Collection paths are identical.** `packages/schemas/src/<domain>.ts` mirrors the Flutter `@EasyFirebase(collectionName: ...)`. No data migration during phases 0–5.
2. **Field names are identical.** `cpf_cnpj`, `data_cadastro`, `mid`, `forma_de_pagamento` — wire format preserved (snake_case where the Flutter side used snake_case, even if it offends the JS style).
3. **Wire-format enums.** Int-coded enums (`STATUS_PAGAMENTO`, `INTEGRACAO_PEDIDO`, `EstadoConversa`) keep the same integer values. String-coded enums (`origem`, `tipo` for cliente) keep their string codes.
4. **Schemas soft-parse on read.** When the Flutter app writes a field this app's schema doesn't yet model, the read passes through unchanged (`.passthrough()` on schemas) and the schema simply doesn't surface it to UI.
5. **Server-managed fields are pass-through.** Vector embeddings (`nome_embedding`, `telefone_embedding`), Cloud Function side-effects, etc. never round-trip through this app.

## Permission claims

Custom claims encoded as BigInt strings:

```ts
hasPerm(userClaims.permissions, PERM.cliente.read);  // bool
```

The Flutter app encodes the same way; both share the rules' interpretation. Adding a new permission bit requires a coordination point — bits are grouped per domain in `packages/auth/src/permissions.ts` to avoid collisions.

## Rules ownership

Until Phase 1 settles a generator (ADR-0003), `firestore.rules` lives in the Flutter repo and is deployed by that app's tooling. The Next.js side reads but does not deploy rules.

## Eventual decoupling

When the migration is done:

1. Flip rule deployment to the Next.js repo (after Phase 6.1 split).
2. Retire Flutter app code paths one feature at a time.
3. Eventually delete fields the Next.js app no longer authors (denormalisations, cascade triggers).
