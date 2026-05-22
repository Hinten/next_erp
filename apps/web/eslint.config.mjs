import base from '@delfrance/config-eslint';
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
          ],
        },
      ],
    },
  },
];

export default config;
