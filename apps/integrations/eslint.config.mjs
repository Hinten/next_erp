import base from '@delfrance/config-eslint';
import next from 'eslint-config-next';

// Flat config REPLACES a rule's value per matching `files` block — it does not
// merge arrays. So when we extend `no-restricted-syntax` with our own selectors
// we must re-include the base selectors (the `catch` convention), or they'd be
// silently dropped.
const baseRestrictedSyntax =
  base.find((c) => c.rules?.['no-restricted-syntax'])?.rules?.[
    'no-restricted-syntax'
  ]?.slice(1) ?? [];

// Funnel all Firestore access through schema-validated `defineAdminCollection`
// handles. Admin refs are built via METHODS (`db.collection()`, `db.doc()`,
// `db.collectionGroup()`), which `no-restricted-imports` can't catch — so ban
// the method calls. The singleton + the `lib/data/*` handle layer are exempt
// below.
const noRawAdminFirestoreRefs = [
  {
    selector: "CallExpression[callee.property.name='collection']",
    message:
      'Do not build raw Firestore refs with `.collection()`. Use a defineAdminCollection() handle from `@/lib/data/*` — it validates writes against the Zod schema. See packages/data/src/admin.',
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
      'no-restricted-syntax': [
        'error',
        ...baseRestrictedSyntax,
        ...noRawAdminFirestoreRefs,
      ],
    },
  },
  {
    // The admin singleton legitimately calls getFirestore. (Collection handles
    // used to live under lib/data/ and were exempt here too; they now live in
    // the shared registry @delfrance/data/admin/collections.) Keep the base
    // `catch` convention enforced here, just drop the Firestore-ref bans.
    files: ['lib/firebase/admin.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': ['error', ...baseRestrictedSyntax],
    },
  },
];

export default config;
