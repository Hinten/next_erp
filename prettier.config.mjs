/**
 * Single source of truth for Prettier across the monorepo.
 *
 * Values mirror the long-standing repo convention (single quotes, width 100)
 * so adopting Prettier reflows whitespace/wrapping only — it does not churn
 * string-literal quote style. Prettier is centralized as one root devDependency
 * and run from the root `format` / `format:check` scripts (not via Turbo).
 *
 * No Tailwind plugin: the UI layer is Mantine.
 *
 * @type {import("prettier").Config}
 */
const config = {
  printWidth: 100,
  tabWidth: 2,
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  arrowParens: 'always',
  endOfLine: 'lf',
};

export default config;
