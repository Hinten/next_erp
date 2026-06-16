// Library-side ESLint config for @delfrance/integrations-freight-br.
// Mirrors the nfe package: does NOT extend `@delfrance/config-eslint`
// (that base ships React Compiler rules needing eslint-plugin-react-hooks,
// consumed by apps/* via eslint-config-next — this library has no React
// surface). We ship the type-aware async-correctness rules + prettier.
// The "no generic catch" convention (CLAUDE.md rule 6) is followed by hand
// here and stays lint-enforced at the apps/* boundary.
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

const config = [
  {
    ignores: ['**/.next/**', '**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  {
    files: ['**/*.ts', '**/*.mts', '**/*.cts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
  },
  // Type-aware async-correctness rules, scoped to `src/**` + `test/**` to
  // match the typed program. `projectService` discovers the nearest tsconfig.
  {
    files: ['src/**/*.{ts,mts}', 'test/**/*.{ts,mts}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  // eslint-config-prettier LAST — disables stylistic rules that conflict with
  // Prettier (formatting is owned by `prettier.config.mjs` / `pnpm format`).
  eslintConfigPrettier,
];

export default config;
