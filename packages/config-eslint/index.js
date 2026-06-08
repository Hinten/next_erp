// Flat config base. Apps and packages extend this and add framework-specific
// rules (e.g., apps/web extends with eslint-config-next).
import noInlineAdminCollection from './rules/no-inline-admin-collection.js';

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
      // Funnel all Cloud Storage access through the @delfrance/storage helpers
      // (content-addressing, dedup, the Arquivo doc, and the product-scoped
      // path conventions). Ban the raw operation functions — `getStorage` for
      // the app's Storage singleton stays allowed. Flat config REPLACES this
      // rule when an app re-declares `no-restricted-imports` (see apps/web),
      // so any such app must re-include this entry.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'firebase/storage',
              importNames: [
                'ref',
                'uploadBytes',
                'uploadBytesResumable',
                'uploadString',
                'getDownloadURL',
                'deleteObject',
              ],
              message:
                'Do not call the raw Storage SDK. Use the helpers from @delfrance/storage (uploadFile / uploadProductImage / uploadFromUrl) — `getStorage()` for the singleton is fine.',
            },
          ],
        },
      ],
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
