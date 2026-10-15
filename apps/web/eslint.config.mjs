import base, { baseRestrictedImportPaths, prettier, typeAware } from '@delfrance/config-eslint';
import react from '@delfrance/config-eslint/react';
import next from 'eslint-config-next';

/**
 * Every `no-restricted-imports` path this app enforces.
 *
 * ⚠️ Hoisted to a const because flat config replaces this rule by NAME, not by
 * entry: the scoped block below re-declares it to add the `firebase-admin`
 * pattern, and without spreading this list that block would silently switch the
 * NF-e and raw-Firestore-ref bans back off for `app/`, `lib/` and `components/`
 * — the exact surface they exist to protect.
 */
const restrictedImportPaths = [
  {
    // The root `@delfrance/integrations-nfe` specifier pulls server-only
    // modules (soap, node-forge, fs) that break the browser bundle. apps/web
    // must import from the `/http-provider` subpath instead, which exposes only
    // the typed HTTP client + error classes. See
    // `packages/integrations/nfe/CLAUDE.md` (Subpath exports).
    name: '@delfrance/integrations-nfe',
    message:
      'Use `@delfrance/integrations-nfe/http-provider` — the root specifier pulls server-only modules (soap, node-forge, fs) that break the browser bundle.',
  },
  {
    // Raw collection()/doc()/collectionGroup() build references WITHOUT the Zod
    // converter, so writes skip schema.parse() and lose type-checking. Get refs
    // from a defineCollection() handle instead, which pairs the path with its
    // schema and validates.
    name: 'firebase/firestore',
    importNames: ['collection', 'doc', 'collectionGroup'],
    message:
      'Do not build raw Firestore refs. Use a defineCollection() handle: `xCollection.ref(db, ctx)` / `xCollection.docRef(db, ctx, id)` (apps/web/lib/data/*), or `groupQuery(db, id, xCollection.converter)` from @delfrance/data for collection groups.',
  },
  // The base block's Cloud Storage ban, spread rather than re-typed. It used to
  // be a hand-copied duplicate here, and the five sibling backends that copied
  // nothing lost the ban entirely.
  ...baseRestrictedImportPaths,
];

const config = [
  ...base,
  ...react,
  ...next,
  // registerPlugin: false — eslint-config-next already registers @typescript-eslint.
  ...typeAware(import.meta.dirname, { registerPlugin: false }),
  {
    rules: {
      // React Compiler-aware rules from eslint-plugin-react-hooks v7. The
      // project doesn't enable React Compiler yet; keep these as advisory
      // warnings instead of errors so existing patterns don't block CI.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',

      'no-restricted-imports': ['error', { paths: restrictedImportPaths }],
    },
  },

  // `firebase-admin` must never reach the browser bundle. apps/web is
  // client-first (root `CLAUDE.md` rule 5, `apps/web/CLAUDE.md` rule 1): server
  // compute belongs to the API-only sibling apps and `apps/functions`, and
  // security lives in Firestore rules rather than in a server surface here.
  //
  // Zero violations today, which is why this is `error` rather than a ratchet —
  // but nothing enforced it, and the failure is the silent kind: importing it
  // typechecks, lints and builds, and simply ships the Admin SDK to the browser.
  // Same shape as the `ai-root-entry-browser-safe` backstop.
  //
  // ⚠️ Scoped to APP code, and it must re-spread `restrictedImportPaths`:
  // `e2e/**` legitimately drives Firestore through the Admin SDK in its helpers
  // and in `pedidos-estado.vendas.e2e.spec.ts` (Node under Playwright, never
  // bundled), so the ban cannot be global — and a block that narrows the rule
  // replaces its whole value for the files it matches.
  {
    files: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: restrictedImportPaths,
          patterns: [
            {
              group: ['firebase-admin', 'firebase-admin/*'],
              message:
                'The Firebase Admin SDK must never reach the browser bundle. apps/web is client-first: read and write with the client SDK through a defineCollection() handle, and put server compute in the API-only sibling app for that channel or in apps/functions.',
            },
          ],
        },
      ],
    },
  },
  // eslint-config-prettier LAST — disables stylistic rules that conflict with
  // Prettier (formatting is owned by `prettier.config.mjs` / `pnpm format`).
  prettier,
];

export default config;
