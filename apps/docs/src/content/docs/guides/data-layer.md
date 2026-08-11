---
title: Data layer
description: Zod schemas + defineCollection + cascade — how the framework reads and writes Firestore without codegen.
---

Delfrance's data layer is intentionally tiny. There's no codegen for queries, types, or form widgets — the Firestore SDK is already typed enough when paired with Zod schemas as the source of truth.

## Three pieces

1. **`@delfrance/schemas`** — Zod schemas + `CollectionMetadata` (path, permission bits, cascade declarations) per domain.
2. **`@delfrance/data`** — `defineCollection<T>` wrapper around the Firestore SDK; query helpers (`whereEqual`, `orderByField`, `paginate`); cascade runtime.
3. **`@delfrance/data/hooks`** — `useSnapshot(query)` and `useDocSnapshot(ref)` for real-time React state.

## Authoring a domain

```ts
// packages/schemas/src/cliente.ts
import { z } from 'zod';
import type { CollectionMetadata } from './types';

export const clienteSchema = z.object({
  nome: z.string().max(255).nullable().optional(),
  cpf_cnpj: z.string().max(18).regex(/^\d*$/).nullable().optional(),
  // …
});

export const clienteMeta: CollectionMetadata = {
  collectionPath: 'clientes',
  permissions: {
    read: 1n << 0n,
    write: 1n << 1n,
    delete: 1n << 2n,
  },
  cascade: [{ path: 'clientes/{clienteId}/enderecos', onDelete: 'cascade' }],
};
```

## Consuming from `apps/web`

```ts
// apps/web/lib/data/clienteCollection.ts
import { defineCollection } from '@delfrance/data';
import { clienteSchema } from '@delfrance/schemas';

export const clienteCollection = defineCollection({
  path: 'clientes',
  schema: clienteSchema,
});
```

Reads / writes:

```tsx
// list view
import { buildQuery, orderByField, limit } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';

const q = buildQuery(
  clienteCollection.ref(getFirebaseFirestore(), {}),
  [orderByField('nome'), limit(50)],
);
const { data, loading, error } = useSnapshot(q);
```

```ts
// write
import { addDoc } from 'firebase/firestore';
await addDoc(clienteCollection.ref(getFirebaseFirestore(), {}), values);
```

## Path placeholders

Subcollections use `{name}` placeholders resolved from a `PathContext`:

```ts
defineCollection({
  path: 'clientes/{clienteId}/enderecos',
  schema: enderecoSchema,
});

// later:
collection.ref(db, { clienteId: 'abc' });   // → clientes/abc/enderecos
```

## Cascade

Firestore never cascades subcollections: deleting a parent leaves every child orphaned. Cascades therefore run **server-side, in a Cloud Function**, never from the client.

Most collections use the shared factory in `apps/functions/src/lib/cascadeCaroGenerico.ts`:

```ts
// apps/functions/src/cascades/caroGenericoTriggers.ts
export const onIntegracaoDeleted = defineCascadeCaroGenerico(integracaoMeta);
```

Two properties of that factory are load-bearing:

- It discovers children with `listCollections()` rather than reading `meta.cascade`. A registry-derived list silently orphans whatever it does not know about — Flutter writes subcollections this repo never registered, and `integracaoMeta.cascade` omits `brandshopee` today.
- It is called **caro** ("expensive") on purpose: the walk costs one `listCollections()` per document reached, leaves included, so it suits collections whose deletes are rare and whose subtrees are small. A hot delete path or a wide subtree wants a targeted, kinded sweep instead.

Never use `db.recursiveDelete` — on Firestore Enterprise its kindless descendant query cannot be indexed and bills as a silent full scan (~6,184 documents per call). See `apps/functions/CLAUDE.md`.

**A declared `cascade` does not mean an enforced one.** `pedidoMeta` and `clienteMeta` both declare one and deliberately have no trigger, because their children are fiscal records an emitted NF-e still depends on (`pedidos/{id}/nfev4`; and a cliente's endereço, which the NF-e orchestrator reads live by ref). The reasoning is recorded at each declaration.

:::caution[Superseded]
`applyCascade(meta, opts)` in `@delfrance/data/server` is the old meta-driven helper. It has no runtime callers — only its own unit test — and its registry-derived shape is the one described above. Do not wire it into anything new.
:::

## Validation policy

- **On write**: strict-parse via `schema.parse(value)`. Bad data never lands in Firestore.
- **On read**: soft-parse via `schema.safeParse(raw)`. Mismatches log a warning and pass through the raw doc — useful while migrating fields from the Flutter app without bricking the UI.

## What's not here

- No query builders generated per model — the Firestore SDK + `defineCollection<T>` already give you typed refs.
- No form widgets generated per field — react-hook-form + Mantine `Controller` covers that with manual components.
- No cascade-delete code generation — one runtime helper that reads metadata is enough.
- No JSON converter generation — `withConverter(converter)` from the SDK + `schema.parse` is the converter.
