import base, { prettier, typeAware } from '@delfrance/config-eslint';
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
  ...next,
  // registerPlugin: false — eslint-config-next already registers @typescript-eslint.
  ...typeAware(import.meta.dirname, { registerPlugin: false }),
  {
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',

      // `getFirestore` may only be called inside the admin singleton; everyone
      // else imports `getAdminFirestore` from `@/lib/firebase/admin`.
      'no-restricted-imports': [
        'error',
        {
          paths: [
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
    // The admin singleton legitimately calls getFirestore. (The nested Cloud
    // Functions codebase lands in a later PR; add its `admin.ts` here then.)
    files: ['lib/firebase/admin.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': ['error', ...baseRestrictedSyntax],
    },
  },
  // eslint-config-prettier LAST — disables stylistic rules that conflict with
  // Prettier (formatting is owned by `prettier.config.mjs` / `pnpm format`).
  prettier,
];

export default config;
