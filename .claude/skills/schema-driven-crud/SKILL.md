---
name: schema-driven-crud
description: >-
  Use when adding or editing a schema-driven CRUD screen in apps/web — the
  list, detail/edit and create pages for a Firestore collection built with
  TableView and ObjectView from @delfrance/ui — and when writing the e2e
  tests and the CI workflow that validate them. Triggers on requests like
  "create the X page", "add a TableView/ObjectView for X", "X registration
  screen", "e2e tests for the X schema".
---

# Schema-driven CRUD (TableView / ObjectView)

Guide for building a CRUD feature in `apps/web` from a Zod schema, with no
codegen. The schema is the source of truth: `TableView` (list) and
`ObjectView` (create/edit) derive columns, inputs, labels and validation
straight from it.

## 1. When to use / when NOT to use

**Use** for the standard list/detail/create screen of a Firestore collection.

**Do not use** when the form escapes the generic case — cross-field logic,
sub-collections edited on the same screen, wizards. For those, write a
custom react-hook-form form (see
`apps/web/app/(app)/produtos/_components/ProdutoForm.tsx`).

## 2. Architecture

```
packages/schemas/src/<x>.ts         Zod schema + <x>Meta (CollectionMetadata)
        │
apps/web/lib/data/<x>Collection.ts  defineCollection({ path, schema })
        │
apps/web/app/(app)/<route>/
  page.tsx        list    → <TableView>
  novo/page.tsx   create  → <ObjectView> (no recordId)
  [id]/page.tsx   edit    → <ObjectView> (with recordId)
        │
apps/web/app/(app)/_components/SidebarNav.tsx   menu entry
```

Canonical end-to-end example: **`clientes`** (and `categorias`). When adding
a new entity, open those files and copy the pattern.

## 3. Step-by-step recipe

### 3.1 Schema — `packages/schemas/src/<x>.ts`

- `z.object({...})`; every field with `.describe('Label')` — the text
  becomes the UI label (`extractFieldsFromSchema` reads it).
- Optional field: **`.nullable().default(null)`**. Never `.optional()`
  alone — the Firebase JS SDK rejects `undefined` in `setDoc`/`addDoc`.
- Required field: `z.string().min(1)` (no `.nullable()`).
- Enum: `z.enum([...]).meta({ labels: { key: 'Readable label' } })` —
  without `.meta({labels})` the UI shows the raw key.
- Export: `<x>Schema`, `export type X = z.infer<typeof <x>Schema>`, and
  `<x>Meta: CollectionMetadata` (`collectionPath`, `permissions`
  `{ read, write, delete }` as BigInt bits, `cascade?`).
- Re-export everything from `packages/schemas/src/index.ts`.

```ts
export const fooSchema = z.object({
  nome: z.string().min(1).max(255).describe('Nome'),
  status: z.enum(['a', 'b']).meta({ labels: { a: 'Ativo', b: 'Inativo' } })
    .nullable().default(null).describe('Status'),
  observacao: z.string().max(500).nullable().default(null).describe('Observação'),
});
export type Foo = z.infer<typeof fooSchema>;
export const fooMeta: CollectionMetadata = {
  collectionPath: 'foos',
  permissions: { read: PERM_FOO_READ, write: PERM_FOO_WRITE, delete: PERM_FOO_DELETE },
};
```

### 3.2 Collection handle — `apps/web/lib/data/<x>Collection.ts`

```ts
import { fooSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

export const fooCollection = defineCollection({ path: 'foos', schema: fooSchema });
```

### 3.3 List — `app/(app)/foos/page.tsx`

`'use client'` + `<TableView>`. Per-column filters, header sorting, column
projection, column-visibility persistence (localStorage) and syncing
filters/sort to the query string are **automatic** — nothing to wire.

```tsx
'use client';
import Link from 'next/link';
import { Button } from '@mantine/core';
import { fooSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { fooCollection } from '@/lib/data/fooCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function FoosPage() {
  return (
    <TableView<typeof fooSchema>
      title="Foos"
      schema={fooSchema}
      collection={fooCollection}
      db={getFirebaseFirestore()}
      defaultColumns={['nome', 'status']}
      orderBy={{ field: 'nome', direction: 'asc' }}
      rowHref={(id) => `/foos/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/foos/novo">Novo foo</Button>
      )}
    />
  );
}
```

### 3.4 Create — `app/(app)/foos/novo/page.tsx`

`<ObjectView>` **without `recordId`** (create mode), `saveLabel="Criar"`,
`showSaveAndContinue={false}`, `onSaved` → go to the new doc's edit page.

```tsx
<ObjectView
  schema={fooSchema}
  collection={fooCollection}
  db={getFirebaseFirestore()}
  currentUserUid={user?.uid ?? ''}
  excludedFields={['timestamp']}
  saveLabel="Criar"
  showSaveAndContinue={false}
  onSaved={(id) => router.replace(`/foos/${id}`)}
/>
```

### 3.5 Edit — `app/(app)/foos/[id]/page.tsx`

`<ObjectView>` with `recordId={params.id}`. Permission gating: `canEdit` /
`readOnly` / `canDelete` derived from `usePermission(PERM.foo.write)`. The
unsaved-changes guard and the delete modal (type "excluir") are built in.

```tsx
const { allowed: canWrite } = usePermission(PERM.foo.write);
// ...
<ObjectView
  schema={fooSchema}
  collection={fooCollection}
  db={db}
  currentUserUid={user?.uid ?? ''}
  recordId={params.id}
  excludedFields={['timestamp']}
  saveLabel="Salvar alterações"
  canEdit={canWrite}
  readOnly={!canWrite}
  canDelete={canWrite}
  onDelete={async (id) => { await deleteDoc(fooCollection.docRef(db, {}, id)); router.replace('/foos'); }}
  onSaved={() => router.replace('/foos')}
/>
```

### 3.6 Sidebar — `app/(app)/_components/SidebarNav.tsx`

Add a leaf (or a child of a group) to the `NAV` array, with `perm`:

```ts
{ href: '/foos', label: 'Foos', perm: PERM.foo.read },
```

## 4. Reference — `TableView` (`packages/ui/src/table/TableView.tsx`)

| Prop | Use |
|---|---|
| `schema`, `collection`, `db` | Required. `db = getFirebaseFirestore()`. |
| `title`, `description` | Header. |
| `defaultColumns` | Initial visible columns. Omitted → every non-`unknown` field. |
| `orderBy` | Initial sort `{ field, direction }`. User changes it by clicking the header. |
| `rowHref` | `(id, row) => string` — row-click target. |
| `renderNewButton` | "New" button (use `<Button component={Link}>`). |
| `fields` | `Record<string, FieldConfig>` — per-field overrides (see §6). |
| `selectable` + `actions` | Selection checkbox + bulk actions (e.g. delete). |
| `pageSize` | Rows per page (default 50). |
| `pathContext` | For sub-collections (`{ parentId }`). |
| `queryOverride` | Escape hatch: pass a ready-made Firestore `Query`. |

## 5. Reference — `ObjectView` (`packages/ui/src/object/ObjectView.tsx`)

| Prop | Use |
|---|---|
| `schema`, `collection`, `db` | Required. |
| `recordId` | Absent → create mode; present → loads and edits the doc. |
| `currentUserUid` | Required — goes into the audit entry. |
| `excludedFields` | Fields to hide (embeddings, `timestamp`, server-managed refs). |
| `fields` | Per-field overrides (see §6). |
| `sections` | Tab names → tabbed layout (omitted → flat layout). |
| `defaultValues` | Initial values in create mode. |
| `canEdit` | `false` → hides the save buttons. |
| `readOnly` | `true` → disables every field (implies `canEdit:false`). |
| `canDelete` + `onDelete` | Delete button + `(id) => Promise` callback. |
| `deleteConfirmMessage` | Delete-modal body text. |
| `onSaved` | `(id) => void` after a successful save. |
| `saveLabel` | Primary button text ("Criar" / "Salvar alterações"). |
| `showSaveAndContinue` | Secondary "Salvar e continuar" button (default true). |

## 6. Reference — `FieldConfig` (`packages/ui/src/schema/types.ts`)

Per-field overrides, passed via `fields={{ field: { ... } }}`:

- `label`, `hint` — override the `.describe()` value.
- `kind` — force the `FieldKind` (`string|longText|email|tel|url|number|integer|currency|boolean|enum|date|reference|array|object|unknown`).
- `options` — `Array<{value,label}>` for enums (overrides `.meta({labels})`).
- `hidden` — hide in both TableView and ObjectView.
- `editable: false` — disable the input in ObjectView only.
- `section` — assign the field to a tab (when `sections` is passed).
- `renderCell: (value, row) => ReactNode` — custom cell in TableView.
- `renderInput: (props: FieldRenderProps) => ReactNode` — custom input in
  ObjectView (e.g. `CpfCnpjInput` in `clientes/[id]/page.tsx`).

## 7. E2e tests

Create `apps/web/e2e/<x>.e2e.spec.ts` (template: `clientes.e2e.spec.ts`).

1. **Register a Playwright project** in `apps/web/playwright.config.ts`:
   ```ts
   { name: 'foos', testMatch: /foos\.e2e\.spec\.ts$/, use: { ...devices['Desktop Chrome'] } },
   ```
2. `test.describe.serial(...)`. Do NOT add a `test.skip(!requiresAuthEnv())`
   gate — when the e2e env is missing the suite should fail loudly (the
   `beforeAll` seed throws a clear Admin SDK error), not skip silently.
3. **Seeding**: add `seedFoos` to `apps/web/e2e/_helpers/seed-data.ts`
   (uses the Admin SDK `db()`). In `beforeAll` seed 5–10 docs with `nome`
   prefixed by `e2ePrefix('foo')`; in `afterAll` call
   `cleanupByNamePrefix('foos', prefix)`. The prefix is run-id scoped.
4. **Canonical scenarios** (cover all):
   query without a filter · per-column filter (text/enum/boolean) · empty
   state · header sorting · navigate to `/novo` · create · create with a
   schema error · open an existing doc · edit then try to leave
   (unsaved-changes guard, `window.confirm` → `page.on('dialog')`) · save ·
   save and continue · edit with a schema error · delete (type-"excluir"
   modal) · filters and sort in the query string.
5. **UI-driver helpers** — `apps/web/e2e/helpers/table-view.ts` and
   `object-view.ts`: `applyTextFilter`, `applySelectFilter`,
   `clearColumnFilter`, `clickColumnSort`, `expectRowVisible`/
   `expectRowHidden`, `expectEmptyState`, `firstRowText`; `fillField`,
   `selectField`, `clickSave`, `clickSaveAndContinue`, `confirmDelete`,
   `expectFieldError`, `expectErrorText`, `expectToast`. Reuse — only add a
   helper if something is missing.

## 8. CI workflow — `.github/workflows/<x>-e2e.yml`

Copy `.github/workflows/clientes-e2e.yml`. Adjust:

- `name:` and the comment.
- `on.pull_request.paths:` — the schema (`packages/schemas/src/<x>.ts` +
  `index.ts`), `packages/ui/src/{table,object,schema}/**`,
  `packages/data/**`, `apps/web/app/(app)/<route>/**`, the collection
  handle, the spec, the e2e infra (`e2e/helpers/**`, `e2e/_helpers/**`,
  `e2e/_setup/**`, `global-setup.ts`, `global-teardown.ts`,
  `playwright.config.ts`), `tools/test-fixtures/**`, `pnpm-lock.yaml`, and
  the workflow file itself.
- Keep `branches: [master, main]` and the `concurrency` block.
- The run step pipes the Playwright output to a file
  (`... | tee /tmp/e2e.log`, with `set -o pipefail`) and a follow-up
  `if: failure()` step posts `tail -c 12000 /tmp/e2e.log` to the PR via
  `gh pr comment`. Add `permissions: pull-requests: write` to the job.
  Do this in the workflow itself — `post-ci-logs.yml` (a `workflow_run`
  workflow) always runs the default-branch definition, so it cannot see a
  feature branch's new workflow; an in-workflow comment works immediately.

The workflow only fires when the `paths` match. It mirrors the `e2e-smoke.yml`
job. The filtered-workflow pattern is also documented in the root `CLAUDE.md`.

## 9. Verification

- `pnpm turbo run lint typecheck test` — green.
- `pnpm --filter @delfrance/web build` — no Suspense/SSR error.
- `pnpm --filter @delfrance/web exec playwright test --list --project=<x>`
  — lists the new spec's tests, without leaking into `smoke`.
- e2e against staging: needs `E2E_USER_*` + `FIREBASE_*` in the environment.
  Without them the suite fails loudly (by design — no graceful skip).

## 10. Pitfalls

- **Never `.optional()` without `.nullable()`** — Firebase rejects `undefined`.
- **`excludedFields`** for server-managed fields (embeddings, `timestamp`,
  outer-refs) — otherwise they show up as editable inputs.
- **An enum without `.meta({ labels })`** shows the raw key in the UI.
- **Do not pass a manual `select`** that could drop the row id — TableView
  already projects the visible columns while preserving identity.
- The old `CLAUDE.md` rule "do not add `.github/workflows/*.yml`" is
  **outdated** — the workflows are already active in the repo.
