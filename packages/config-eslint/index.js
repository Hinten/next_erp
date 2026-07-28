// Flat config base. Apps and packages extend this and add framework-specific
// rules (e.g., apps/web extends with eslint-config-next).
import noInlineAdminCollection from './rules/no-inline-admin-collection.js';
import defaultQueryNeedsIndex from './rules/default-query-needs-index.js';
import noAdHocMoneyRounding from './rules/no-ad-hoc-money-rounding.js';
import noOptionalWithoutNullable from './rules/no-optional-without-nullable.js';
import noErrorAsSoleInstanceof from './rules/no-error-as-sole-instanceof.js';
import preferSchemaEnum from './rules/prefer-schema-enum.js';
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
        // Type-aware: it resolves the Zod enum from the type of the position
        // the literal sits in, so it lives here rather than in the base block.
        // The `delfrance` plugin is registered in the base block, which merges
        // with this one for the same file.
        'delfrance/prefer-schema-enum': 'error',
      },
    },
  ];
}

const config = [
  {
    ignores: ['**/.next/**', '**/dist/**', '**/out/**', '**/node_modules/**', '**/coverage/**'],
  },
  // ESLint's flat-config default (`**/*.{js,mjs,cjs}`) does not include `.ts` —
  // a file is only linted at all if SOME block's `files` matches it. Without
  // this block, `eslint .` would silently skip root-level `*.ts` config files
  // (e.g. a library workspace's own `vitest.config.ts`) in any workspace that
  // doesn't also spread `typeAware(...)`. Deliberately non-type-aware (no
  // `parserOptions.projectService`, no `rules`) — it only lets the TS parser
  // see the file. `typeAware(...)` is spread after `...base` in every
  // consumer, so for files it also covers its block sits later in the array
  // and wins (a later block's `languageOptions` for the same file replaces
  // this one's, it doesn't merge with it).
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
  },
  {
    plugins: {
      delfrance: {
        rules: {
          'no-inline-admin-collection': noInlineAdminCollection,
          'default-query-needs-index': defaultQueryNeedsIndex,
          'no-ad-hoc-money-rounding': noAdHocMoneyRounding,
          'no-optional-without-nullable': noOptionalWithoutNullable,
          'no-error-as-sole-instanceof': noErrorAsSoleInstanceof,
          'prefer-schema-enum': preferSchemaEnum,
        },
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

      // Keep Admin-SDK collection handles in the canonical registry at
      // packages/data/src/admin/collections (imported via
      // @delfrance/data/admin/collections). Warn — a guard against
      // re-scattering, not a hard gate. See rules/no-inline-admin-collection.js.
      'delfrance/no-inline-admin-collection': 'warn',

      // Every collection defaultQuery must have a matching Firestore index in
      // firestore.indexes.json (Enterprise creates none automatically). Error —
      // a missing index is a real collection-scan bug. Only fires on
      // CollectionMetadata literals (objects with a string collectionPath).
      // See rules/default-query-needs-index.js.
      'delfrance/default-query-needs-index': 'error',

      // Money math + BRL display must funnel through roundReais() / formatReais()
      // from @delfrance/core/money — ad-hoc `.toFixed(2)` / `Math.round(x * 100)`
      // are forbidden (the canonical impls + wire-format serializers are
      // allow-listed in the rule). See rules/no-ad-hoc-money-rounding.js.
      'delfrance/no-ad-hoc-money-rounding': 'error',

      // In packages/schemas, `.optional()` must be paired with `.nullable()` —
      // the Firebase SDK rejects `undefined` in addDoc/setDoc, so a bare
      // `.optional()` is a runtime crash on the first blank input. The rule
      // self-scopes by path, so this entry is inert outside packages/schemas,
      // which receives it by spreading this base like every other library.
      // See rules/no-optional-without-nullable.js.
      'delfrance/no-optional-without-nullable': 'error',

      // The half of the no-generic-catch rule the `no-restricted-syntax`
      // selectors below cannot express: they check that SOME `instanceof`
      // exists, not WHICH class. `Error` is the parent of every exception, so
      // narrowing only on it swallows FirebaseError/ZodError alike.
      //
      // The distinct rule name matters: flat config does full-replacement per
      // rule NAME, so this survives the `no-restricted-syntax` overrides in
      // apps/nfe and packages/integrations/nfe that drop the base catch
      // selectors — which is exactly where it earns its keep (18 of the 51
      // current hits are in apps/nfe).
      //
      // Warn, not error: 51 pre-existing sites, mostly benign `.message`
      // extraction. A ratchet against backsliding, mirroring
      // no-inline-admin-collection. NOTE lint-staged runs `--max-warnings 0`,
      // so editing one of those 51 files means fixing it first.
      'delfrance/no-error-as-sole-instanceof': 'warn',
    },
  },
];

export default config;
