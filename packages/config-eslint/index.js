// Flat config base. Apps and packages extend this and add framework-specific
// rules (e.g., apps/web extends with eslint-config-next).
import noInlineAdminCollection from './rules/no-inline-admin-collection.js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// Re-export eslint-config-prettier so every consumer can append it as the LAST
// element of its flat config, switching off any stylistic rules that would
// conflict with Prettier. Centralized here so the dependency lives in one place.
export const prettier = eslintConfigPrettier;

/**
 * High-signal, type-aware async-correctness rules. Spread the result into a
 * workspace's flat config: `...typeAware(import.meta.dirname)`.
 *
 * `projectService: true` lets typescript-eslint discover the nearest tsconfig
 * for each linted file; `tsconfigRootDir` must be the consuming workspace dir,
 * so always pass `import.meta.dirname`. Scope `files` to what that workspace's
 * tsconfig `include`s — apps include everything (default
 * `**​/*.{ts,tsx,mts,cts}`), while library packages keep sources under `src/`
 * and should pass `{ files: ['src/**​/*.{ts,mts}'] }` so root-level config `.ts`
 * files (outside the typed program) don't trip "file not in project".
 *
 * We deliberately do NOT enable `recommendedTypeChecked`: its `no-unsafe-*`
 * family floods on the untyped Firebase / SOAP SDK surfaces. These three rules
 * are the high-value async-correctness subset worth gating CI on.
 *
 * `registerPlugin` (default `true`) makes the block self-contained — it
 * registers the `@typescript-eslint` plugin the rules below need, so a config
 * that does NOT extend `eslint-config-next` works out of the box. Consumers
 * that DO spread `eslint-config-next` (every app in this repo) must pass
 * `registerPlugin: false`: next already registers that plugin and flat config
 * forbids defining a plugin name twice ("Cannot redefine plugin").
 *
 * @param {string} tsconfigRootDir usually `import.meta.dirname`
 * @param {{ files?: string[], registerPlugin?: boolean }} [opts]
 */
export function typeAware(
  tsconfigRootDir,
  { files = ['**/*.{ts,tsx,mts,cts}'], registerPlugin = true } = {},
) {
  return [
    {
      files,
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      ...(registerPlugin ? { plugins: { '@typescript-eslint': tseslint.plugin } } : {}),
      rules: {
        '@typescript-eslint/no-floating-promises': 'error',
        // checksVoidReturn.attributes:false silences only the benign JSX
        // handler case (onClick={async () => …}); the dangerous misuses still fire.
        '@typescript-eslint/no-misused-promises': [
          'error',
          { checksVoidReturn: { attributes: false } },
        ],
        '@typescript-eslint/await-thenable': 'error',
      },
    },
  ];
}

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
