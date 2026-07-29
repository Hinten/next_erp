# apps/web — CLAUDE.md

Internal ERP UI. **Client-first.**

## Rules specific to this app

1. **Default to `'use client'`**. The ERP is behind auth, no SEO, no indexing. Server runtime exists (Firebase App Hosting) but only serves the shell + static bundle. Server Components/Actions/route handlers are exceptions that need PR justification.
2. **No `middleware.ts`**. Auth guard is `useRequireAuth()` from `lib/auth/`. The hook listens to `onAuthStateChanged` and redirects to `/login` if user is null. Loading flicker is mitigated by Firebase's IndexedDB persistence.
3. **Reads/writes go directly to Firebase JS SDK** from client components. Wrap one-shot reads in TanStack Query (`useQuery`); wrap real-time in custom hooks built on `onSnapshot`. **Partial updates go through the collection handle's `merge()`** (`defineCollection`), never `setDoc(docRef, patch, { merge: true })` on a converted ref — the converter full-parses the patch, so schema defaults fill in and the merge mask overwrites the stored sibling fields.
4. **Forms**: react-hook-form + Zod resolver. Mantine inputs via `Controller`. With `@hookform/resolvers` v5 + Zod v4, schemas whose input/output types differ (e.g. fields with `.default()`) need the 3-generic `useForm<Input, Context, Output>` form so the resolver and `handleSubmit` callback line up. For standard list/detail/create screens prefer `TableView` / `ObjectView` from `@delfrance/ui` (derived from the Zod schema, organized into tabs via the `sections` prop and overridden per-field via the `fields` prop — see `app/(app)/produtos/` for a multi-tab example). Write a custom form only when the generics don't fit.
5. **Permissions**: `usePermission(0b00001000n)` (BigInt literal — claims are encoded as BigInt strings to dodge the JS 53-bit number limit).
6. **Multi-tenant context**: `useTenant()` reads `grupoEconomico` from custom claims. All queries filter by it.
7. **Staged deletion in editors**: destructive removal of items inside an editor (array fields, sub-records) is **never immediate**. Clicking delete **marks** the item — keep it visible with a clear cue (dimmed / "Será excluída") and an **undo** affordance — and apply the removal **only when the parent record is saved**. Mechanism: mark items in-place with `DELETE_MARK` and wire the field's `FieldConfig.prepareForSave = stripMarkedForDeletion` (both from `@delfrance/ui`); `ObjectView` runs `prepareForSave` at save time. See `components/photo-manager/PhotoManager.tsx` (the owner-agnostic gallery used by produtos + medidas) for the reference implementation.
8. **e2e specs assert a BEHAVIOUR, never a DEPLOYMENT STATE.** The tell: if a test's *name* has to explain what is or is not deployed, it is the wrong test. It will pass right up until the deployment changes, then fail on **every** PR. `produto-preco.cadastros.e2e.spec.ts` once held `'shows the empty state in the cost-history modal (no trigger deployed on staging)'`; the day the `storage` codebase shipped `onProdutoChanged` (#308) the modal grew rows, and that assertion was dead — `5c682b5d` deleted it, but not before it cost PR #719 a full investigation. Assert what the code does; when you need the real trigger output, assert it deterministically in the **emulator lane** (`*.emulator.e2e.spec.ts`), which owns its own backend. Staging specs must also tolerate rows written by whichever concurrent spec touched the same doc. Enforced by `e2e/spec-conventions.test.ts` (Vitest, runs in `ci.yml`), which greps spec titles for deployment-fact phrasing.

## Structure

```
app/
  layout.tsx              Root: Mantine + Notifications + QueryProvider + AuthProvider
  page.tsx                /  → redirects to /inicio (logged in) or /login
  (auth)/
    login/page.tsx        signInWithEmailAndPassword
    recuperar/page.tsx    sendPasswordResetEmail
  (app)/
    layout.tsx            useRequireAuth + AppShell sidebar/header
    inicio/page.tsx       Dashboard placeholder
    clientes/             Phase 1
    produtos/             Phase 3
    pedidos/              Phase 3
    pagamentos/           Phase 3
    nfe/                  Phase 5 (UI; emission server-side in apps/integrations)
    chat/                 Phase 4 — THE unified inbox (all channels)
    whatsapp/             redirect stubs → /chat (inbox unified there)
    canais/               Phase 5
    relatorios/           Phase 3
    configuracoes/        Phase 2+
lib/
  firebase/client.ts      Singletons: getFirebaseApp, getFirebaseAuth, getFirebaseFirestore
  auth/                   AuthProvider, useAuth, useRequireAuth, useTenant, usePermission
  query/QueryProvider.tsx TanStack Query provider
```

## Dev

```bash
cp .env.example .env.local         # fill in Firebase config from your project
pnpm dev                           # run ALL apps in parallel from the repo root
```

`pnpm dev` at the root starts web (:3000), integrations (:3001), webchat (:3002), and docs (:3003) together — required for admin features (user creation, claims refresh) since they POST to `apps/integrations` on :3001. The single-app form `pnpm --filter @delfrance/web dev` works for non-admin pages but causes a 404 on `POST /api/admin/users` because integrations isn't running.

## Deploy

Firebase App Hosting. Site: configured per-deployment (e.g. `app-<your-org>`). Config: `apphosting.yaml` here. Secrets via Firebase console (Cloud Secret Manager).
