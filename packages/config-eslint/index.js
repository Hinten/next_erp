// Flat config base. Apps and packages extend this and add framework-specific
// rules (e.g., apps/web extends with eslint-config-next).
import noInlineAdminCollection from './rules/no-inline-admin-collection.js';
import eslintConfigPrettier from 'eslint-config-prettier';

// Re-export eslint-config-prettier so every consumer can append it as the LAST
// element of its flat config, switching off any stylistic rules that would
// conflict with Prettier. Centralized here so the dependency lives in one place.
export const prettier = eslintConfigPrettier;

const config = [
  {
    ignores: ['**/.next/**', '**/dist/**', '**/out/**', '**/node_modules/**', '**/coverage/**'],
  },
  {
    plugins: {
      delfrance: {
        rules: { 'no-inline-admin-collection': noInlineAdminCollection },
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CatchClause[param=null]',
          message:
            'Bare `catch { }` is forbidden. Bind the error and narrow it via `instanceof <SpecificError>`; rethrow anything that does not match.',
        },
        {
          selector:
            "CatchClause:not(:has(BinaryExpression[operator='instanceof'])):not(:has(ThrowStatement))",
          message:
            'Generic catch is forbidden. The catch body must contain either an `instanceof <SpecificError>` check OR a `throw` (rethrow). Silent fallbacks hide bugs during debugging.',
        },
      ],
      // React Compiler-aware rules from eslint-plugin-react-hooks v7. The
      // project doesn't enable React Compiler yet; keep these as advisory
      // warnings instead of errors so existing patterns don't block CI.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',

      // Keep Admin-SDK collection handles in the canonical registry at
      // packages/data/src/admin/collections (imported via
      // @delfrance/data/admin/collections). Warn — a guard against
      // re-scattering, not a hard gate. See rules/no-inline-admin-collection.js.
      'delfrance/no-inline-admin-collection': 'warn',
    },
  },
];

export default config;
