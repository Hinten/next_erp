import base, { prettier } from '@delfrance/config-eslint';
import next from 'eslint-config-next';

const config = [
  ...base,
  ...next,
  {
    rules: {
      // React Compiler-aware rules from eslint-plugin-react-hooks v7. The
      // project doesn't enable React Compiler yet; keep these as advisory
      // warnings instead of errors so existing patterns don't block CI.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',

      // Guard rail: the root `@delfrance/integrations-nfe` specifier
      // pulls server-only modules (soap, node-forge, fs) that break
      // the browser bundle. apps/web must import from the
      // `/http-provider` subpath instead, which exposes only the
      // typed HTTP client + error classes. See
      // `packages/integrations/nfe/CLAUDE.md` (Subpath exports).
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@delfrance/integrations-nfe',
              message:
                'Use `@delfrance/integrations-nfe/http-provider` — the root specifier pulls server-only modules (soap, node-forge, fs) that break the browser bundle.',
            },
            {
              // Raw collection()/doc()/collectionGroup() build references
              // WITHOUT the Zod converter, so writes skip schema.parse() and
              // lose type-checking. Get refs from a defineCollection() handle
              // instead, which pairs the path with its schema and validates.
              name: 'firebase/firestore',
              importNames: ['collection', 'doc', 'collectionGroup'],
              message:
                'Do not build raw Firestore refs. Use a defineCollection() handle: `xCollection.ref(db, ctx)` / `xCollection.docRef(db, ctx, id)` (apps/web/lib/data/*), or `groupQuery(db, id, xCollection.converter)` from @delfrance/data for collection groups.',
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
