// Library-side ESLint config. Like packages/integrations/nfe, it does NOT
// spread `@delfrance/config-eslint`'s base array: the base ships React Compiler
// (`react-hooks/*`) rules that need `eslint-plugin-react-hooks`, only present
// via `eslint-config-next` in the apps. This package has no React surface, so
// we wire up just the one rule it needs — `delfrance/default-query-needs-index`,
// which validates every collection meta's `defaultQuery` against
// firestore.indexes.json — plus the Prettier compatibility layer.
import tseslint from 'typescript-eslint';
import defaultQueryNeedsIndex from '@delfrance/config-eslint/rules/default-query-needs-index.js';
import { prettier } from '@delfrance/config-eslint';

const config = [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '*.tsbuildinfo'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: {
      delfrance: { rules: { 'default-query-needs-index': defaultQueryNeedsIndex } },
    },
    rules: {
      'delfrance/default-query-needs-index': 'error',
    },
  },
  // eslint-config-prettier LAST — disables stylistic rules that conflict with
  // Prettier (formatting is owned by the repo-root prettier.config.mjs).
  prettier,
];

export default config;
