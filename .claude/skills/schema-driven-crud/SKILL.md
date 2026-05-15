---
name: schema-driven-crud
description: >-
  Use ao adicionar ou editar uma tela CRUD orientada a schema no apps/web —
  lista, detalhe/edição e criação de uma coleção Firestore com TableView e
  ObjectView de @delfrance/ui — e ao escrever os testes e2e e o workflow de
  CI que os validam. Dispara em pedidos como "criar a página de X",
  "adicionar TableView/ObjectView para X", "tela de cadastro de X",
  "testes e2e do schema X".
---

# Schema-driven CRUD (TableView / ObjectView)

Guia para montar uma feature CRUD no `apps/web` a partir de um schema Zod,
sem codegen. O schema é a fonte da verdade: `TableView` (lista) e
`ObjectView` (criação/edição) derivam colunas, inputs, labels e validação
direto dele.

## 1. Quando usar / quando NÃO usar

**Usar** para a tela list/detail/create padrão de uma coleção Firestore.

**Não usar** quando o form foge do genérico — lógica cruzada entre campos,
sub-coleções editadas na mesma tela, wizard. Aí faça um form custom com
react-hook-form (ver `apps/web/app/(app)/produtos/_components/ProdutoForm.tsx`).

## 2. Arquitetura

```
packages/schemas/src/<x>.ts        schema Zod + <x>Meta (CollectionMetadata)
        │
apps/web/lib/data/<x>Collection.ts  defineCollection({ path, schema })
        │
apps/web/app/(app)/<rota>/
  page.tsx        lista   → <TableView>
  novo/page.tsx   criação → <ObjectView> (sem recordId)
  [id]/page.tsx   edição  → <ObjectView> (com recordId)
        │
apps/web/app/(app)/_components/SidebarNav.tsx   entrada no menu
```

Exemplo canônico completo: **`clientes`** (e `categorias`). Ao adicionar uma
entidade nova, abra esses arquivos e copie o padrão.

## 3. Receita passo a passo

### 3.1 Schema — `packages/schemas/src/<x>.ts`

- `z.object({...})`; cada campo com `.describe('Label')` — o texto vira o
  label na UI (`extractFieldsFromSchema` lê isso).
- Campo opcional: **`.nullable().default(null)`**. Nunca `.optional()`
  sozinho — o Firebase JS SDK rejeita `undefined` em `setDoc`/`addDoc`.
- Campo obrigatório: `z.string().min(1)` (sem `.nullable()`).
- Enum: `z.enum([...]).meta({ labels: { chave: 'Label legível' } })` — sem
  o `.meta({labels})` a UI mostra a chave crua.
- Exporte: `<x>Schema`, `export type X = z.infer<typeof <x>Schema>`, e
  `<x>Meta: CollectionMetadata` (`collectionPath`, `permissions`
  `{ read, write, delete }` em bits BigInt, `cascade?`).
- Re-exporte tudo de `packages/schemas/src/index.ts`.

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

### 3.3 Lista — `app/(app)/foos/page.tsx`

`'use client'` + `<TableView>`. Filtros por coluna, ordenação por header,
projeção de colunas, persistência de colunas (localStorage) e sincronização
de filtros/sort na query string são **automáticos** — não precisa wirar nada.

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

### 3.4 Criação — `app/(app)/foos/novo/page.tsx`

`<ObjectView>` **sem `recordId`** (modo create), `saveLabel="Criar"`,
`showSaveAndContinue={false}`, `onSaved` → vai pra edição do novo doc.

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

### 3.5 Edição — `app/(app)/foos/[id]/page.tsx`

`<ObjectView>` com `recordId={params.id}`. Gating por permissão: `canEdit` /
`readOnly` / `canDelete` derivados de `usePermission(PERM.foo.write)`. A
guarda de alterações não-salvas e o modal de exclusão (digitar "excluir")
já vêm embutidos.

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

Adicione um leaf (ou child de um group) ao array `NAV`, com `perm`:

```ts
{ href: '/foos', label: 'Foos', perm: PERM.foo.read },
```

## 4. Referência — `TableView` (`packages/ui/src/table/TableView.tsx`)

| Prop | Uso |
|---|---|
| `schema`, `collection`, `db` | Obrigatórios. `db = getFirebaseFirestore()`. |
| `title`, `description` | Cabeçalho. |
| `defaultColumns` | Colunas visíveis iniciais. Omitido → todos os campos não-`unknown`. |
| `orderBy` | Sort inicial `{ field, direction }`. Usuário troca clicando no header. |
| `rowHref` | `(id, row) => string` — destino do clique na linha. |
| `renderNewButton` | Botão "Novo" (use `<Button component={Link}>`). |
| `fields` | `Record<string, FieldConfig>` — overrides por campo (ver §6). |
| `selectable` + `actions` | Checkbox de seleção + ações em lote (ex.: excluir). |
| `pageSize` | Linhas por página (default 50). |
| `pathContext` | Para sub-coleções (`{ parentId }`). |
| `queryOverride` | Escape hatch: passa uma `Query` Firestore pronta. |

## 5. Referência — `ObjectView` (`packages/ui/src/object/ObjectView.tsx`)

| Prop | Uso |
|---|---|
| `schema`, `collection`, `db` | Obrigatórios. |
| `recordId` | Ausente → modo criação; presente → carrega e edita o doc. |
| `currentUserUid` | Obrigatório — entra na entrada de auditoria. |
| `excludedFields` | Campos a esconder (embeddings, `timestamp`, refs server-managed). |
| `fields` | Overrides por campo (ver §6). |
| `sections` | Nomes de abas → layout em tabs (omitido → layout plano). |
| `defaultValues` | Valores iniciais no modo criação. |
| `canEdit` | `false` → esconde botões de salvar. |
| `readOnly` | `true` → desabilita todos os campos (implica `canEdit:false`). |
| `canDelete` + `onDelete` | Botão excluir + callback `(id) => Promise`. |
| `deleteConfirmMessage` | Texto do modal de exclusão. |
| `onSaved` | `(id) => void` após salvar com sucesso. |
| `saveLabel` | Texto do botão primário ("Criar" / "Salvar alterações"). |
| `showSaveAndContinue` | Botão secundário "Salvar e continuar" (default true). |

## 6. Referência — `FieldConfig` (`packages/ui/src/schema/types.ts`)

Overrides por campo, passados via `fields={{ campo: { ... } }}`:

- `label`, `hint` — sobrescrevem o `.describe()`.
- `kind` — força o `FieldKind` (`string|longText|email|tel|url|number|integer|currency|boolean|enum|date|reference|array|object|unknown`).
- `options` — `Array<{value,label}>` para enum (sobrescreve `.meta({labels})`).
- `hidden` — esconde na TableView e na ObjectView.
- `editable: false` — desabilita o input só na ObjectView.
- `section` — agrupa o campo numa aba (quando `sections` é passado).
- `renderCell: (value, row) => ReactNode` — célula custom na TableView.
- `renderInput: (props: FieldRenderProps) => ReactNode` — input custom na
  ObjectView (ex.: `CpfCnpjInput` em `clientes/[id]/page.tsx`).

## 7. Testes e2e

Crie `apps/web/e2e/<x>.e2e.spec.ts` (template: `clientes.e2e.spec.ts`).

1. **Registre um Playwright project** em `apps/web/playwright.config.ts`:
   ```ts
   { name: 'foos', testMatch: /foos\.e2e\.spec\.ts$/, use: { ...devices['Desktop Chrome'] } },
   ```
2. `test.describe.serial(...)` + `test.skip(!requiresAuthEnv(), ...)` no topo
   (`requiresAuthEnv` de `./helpers/env`).
3. **Seeding**: adicione `seedFoos` em `apps/web/e2e/_helpers/seed-data.ts`
   (usa `db()` do Admin SDK). Em `beforeAll` semeie 5–10 docs com `nome`
   prefixado por `e2ePrefix('foo')`; em `afterAll` chame
   `cleanupByNamePrefix('foos', prefix)`. O prefixo é escopado por run id.
4. **Cenários canônicos** (cobrir todos):
   query sem filtro · filtro por coluna (texto/enum/boolean) · empty state ·
   ordenação por header · ir para `/novo` · criar · criar com erro de schema ·
   abrir um doc existente · alterar e tentar sair (guarda de não-salvo,
   `window.confirm` → `page.on('dialog')`) · salvar · salvar e continuar ·
   editar com erro de schema · excluir (modal "digite excluir") · filtros e
   sort na query string.
5. **Helpers de UI** — `apps/web/e2e/helpers/table-view.ts` e `object-view.ts`:
   `applyTextFilter`, `applySelectFilter`, `clearColumnFilter`,
   `clickColumnSort`, `expectRowVisible`/`expectRowHidden`,
   `expectEmptyState`, `firstRowText`; `fillField`, `selectField`,
   `clickSave`, `clickSaveAndContinue`, `confirmDelete`, `expectFieldError`,
   `expectErrorText`, `expectToast`. Reuse — só adicione se faltar algo.

## 8. Workflow de CI — `.github/workflows/<x>-e2e.yml`

Copie `.github/workflows/clientes-e2e.yml`. Ajuste:

- `name:` e o comentário.
- `on.pull_request.paths:` — o schema (`packages/schemas/src/<x>.ts` +
  `index.ts`), `packages/ui/src/{table,object,schema}/**`, `packages/data/**`,
  `apps/web/app/(app)/<rota>/**`, o collection handle, o spec, a infra e2e
  (`e2e/helpers/**`, `e2e/_helpers/**`, `e2e/_setup/**`, `global-setup.ts`,
  `global-teardown.ts`, `playwright.config.ts`), `tools/test-fixtures/**`,
  `pnpm-lock.yaml`, e o próprio arquivo.
- Mantenha `branches: [master, main]` e o bloco `concurrency`.
- O step de run: `playwright test --project=<x>`.

O workflow só dispara quando os `paths` casam. Espelha o job de
`e2e-smoke.yml`. Padrão também documentado no `CLAUDE.md` raiz.

## 9. Verificação

- `pnpm turbo run lint typecheck test` — verde.
- `pnpm --filter @delfrance/web build` — sem erro de Suspense/SSR.
- `pnpm --filter @delfrance/web exec playwright test --list --project=<x>`
  — lista os testes do spec novo, sem vazar pro `smoke`.
- e2e contra staging: precisa de `E2E_USER_*` + `FIREBASE_*` no ambiente
  (não roda sem isso — o `test.skip` degrada gracioso).

## 10. Armadilhas

- **Nunca `.optional()` sem `.nullable()`** — Firebase rejeita `undefined`.
- **`excludedFields`** para campos server-managed (embeddings, `timestamp`,
  outer-refs) — senão aparecem como inputs editáveis.
- **Enum sem `.meta({ labels })`** mostra a chave crua na UI.
- **Não passe `select` manual** que possa perder o id da linha — a
  TableView já projeta as colunas visíveis preservando a identidade.
- A regra antiga do `CLAUDE.md` "não adicionar `.github/workflows/*.yml`"
  está **desatualizada** — os workflows já estão ativos no repo.
