import base, { baseRestrictedImportPaths, prettier, typeAware } from '@delfrance/config-eslint';
import react from '@delfrance/config-eslint/react';
import next from 'eslint-config-next';

// Flat config REPLACES a rule's value per matching `files` block — it does not
// merge arrays. So when we extend `no-restricted-syntax` with our own selectors
// we must re-include the base selectors (the `catch` convention), or they'd be
// silently dropped.
const baseRestrictedSyntax =
  base.find((c) => c.rules?.['no-restricted-syntax'])?.rules?.['no-restricted-syntax']?.slice(1) ??
  [];

// Funnel all Firestore access through schema-validated `defineAdminCollection`
// handles from the shared registry (`@delfrance/data/admin/collections`). Admin
// refs are built via METHODS (`db.collection()`, `db.doc()`,
// `db.collectionGroup()`), which `no-restricted-imports` can't catch — so ban
// the method calls. Only the admin singleton is exempt below.
const noRawAdminFirestoreRefs = [
  {
    selector: "CallExpression[callee.property.name='collection']",
    message:
      'Do not build raw Firestore refs with `.collection()`. Import a ready-made handle from `@delfrance/data/admin/collections` — it validates writes against the Zod schema.',
  },
  {
    selector: "CallExpression[callee.property.name='doc']",
    message:
      'Do not build raw Firestore refs with `.doc()`. Use a defineAdminCollection() handle (`xCollection.docRef(db, ctx, id)` / `xCollection.set/merge`).',
  },
  {
    selector: "CallExpression[callee.property.name='collectionGroup']",
    message:
      'Do not build raw Firestore refs with `.collectionGroup()`. Use a defineAdminCollection() handle (`xCollection.collectionGroup(db)`).',
  },
];

const config = [
  ...base,
  ...react,
  ...next,
  // registerPlugin: false — eslint-config-next already registers @typescript-eslint.
  ...typeAware(import.meta.dirname, { registerPlugin: false }),
  {
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',

      // `getFirestore` may only be called inside the admin singleton; everyone
      // else imports `getAdminFirestore` from `@/lib/firebase/admin`.
      // ⚠️ `baseRestrictedImportPaths` FIRST: flat config replaces this rule by
      // name, so declaring it here drops the base's Cloud Storage ban unless it
      // is spread back in. All five backends had silently lost it.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...baseRestrictedImportPaths,
            {
              name: 'firebase-admin/firestore',
              importNames: ['getFirestore'],
              message:
                'Import `getAdminFirestore` from `@/lib/firebase/admin` instead — `getFirestore` may only be called in that singleton.',
            },
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...baseRestrictedSyntax, ...noRawAdminFirestoreRefs],
    },
  },
  {
    // The admin singletons legitimately call getFirestore — the app's own and
    // the nested Cloud Functions codebase's (deployed separately).
    files: ['lib/firebase/admin.ts', 'functions/src/lib/admin.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': ['error', ...baseRestrictedSyntax],
    },
  },
  {
    // The emulator suites (ci-mercado-livre.yml) need RAW refs, and for the same
    // reason the rule exists: the handles validate against the Zod schema, and
    // these tests must reach around that validation on purpose. They seed shapes
    // a handle would reject — notably the auto-id docs the legacy Flutter app
    // writes, and a token doc missing `expires_in` — and they read back the
    // PHYSICAL document to check what the handle actually stored. Reading
    // through the handle instead would apply `parseRead`, whose soft-parse is
    // precisely the layer under test. In `*.tasks.test.ts` the document being
    // read back was written by a DIFFERENT process (the function running inside
    // the emulator), which is exactly when you want the raw bytes. Scoped to the
    // two suffixes, so production code and the offline unit tests stay covered.
    files: ['**/*.firestore.test.ts', '**/*.tasks.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...baseRestrictedSyntax],
    },
  },
  // eslint-config-prettier LAST — disables stylistic rules that conflict with
  // Prettier (formatting is owned by `prettier.config.mjs` / `pnpm format`).
  prettier,
];

export default config;
