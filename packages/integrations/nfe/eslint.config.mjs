// Library-side ESLint config. Does NOT extend `@delfrance/config-eslint`
// because the base ships React Compiler rules that require
// `eslint-plugin-react-hooks` (consumed by apps/* via
// `eslint-config-next`). This library has no React surface, and the
// strict catch rule from the base would surface ~19 pre-existing
// violations across `src/**` + `test/**` that are out of scope for the
// pre-real-cert audit. So we ship only the two cert-leak guard rules
// here; the catch rule remains enforced at the apps/* boundary.
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import noAdHocMoneyRounding from '@delfrance/config-eslint/rules/no-ad-hoc-money-rounding.js';

// Rule A — no multi-arg `console.*` in NF-e code paths. See the
// apps-side config for the rationale; the leak shape is the same and
// fires identically for log/info/warn/error/debug. Single-arg text-only
// forms (`console.warn(\`text\`)`) stay legal.
const ruleAConsole = {
  selector:
    'CallExpression[callee.object.name="console"][callee.property.name=/^(log|info|warn|error|debug)$/][arguments.length>=2]',
  message:
    'Multi-arg console.* is forbidden in NF-e code paths — ' +
    'use safeLog(level, ...) from apps/nfe/lib/nfe/log.ts or compose a single ' +
    'template string. safeLog routes every arg through redactSensitive first.',
};

// Rule B — `NFE_CERT_*` env vars may only be READ inside the unified
// loader at `src/cert/index.ts`. Anywhere else must call
// `loadCertificateFromEnv()` or `hasNFeCertEnv()` (both from `./cert`).
const ruleBCertEnv = {
  selector: 'MemberExpression[property.name=/^NFE_CERT_(BASE64|PATH|PASSWORD|ENC_KEY)$/]',
  message:
    'NFE_CERT_BASE64 / NFE_CERT_PATH / NFE_CERT_PASSWORD / NFE_CERT_ENC_KEY may ' +
    'only be read inside packages/integrations/nfe/src/cert/index.ts. Call ' +
    'loadCertificateFromEnv() / hasNFeCertEnv() / getCertEncryptionKey() instead.',
};

const NFE_CODE_PATHS = [
  'src/cert/**/*.ts',
  'src/soap/**/*.ts',
  'src/sign/**/*.ts',
  'src/generator/**/*.ts',
  'src/operations/**/*.ts',
];

const config = [
  {
    ignores: [
      '**/.next/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'generated/**',
      'ca/**',
      'test/**',
      'scripts/**',
      'src/codegen/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.mts', '**/*.cts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
  },
  // NF-e code paths — Rule A (no raw console.*) + Rule B (no
  // NFE_CERT_* env reads). Combined in a single block because flat
  // config does full-replacement on `no-restricted-syntax` between
  // matching blocks. `src/cert/index.ts` is the unified loader — it
  // owns both the audit log channel and the env-var reads, so it's
  // exempt from both rules.
  {
    files: NFE_CODE_PATHS,
    ignores: ['src/cert/index.ts'],
    rules: {
      'no-restricted-syntax': ['error', ruleAConsole, ruleBCertEnv],
    },
  },
  // Rest of `src/` — Rule B only. (Other src dirs don't carry the
  // SEFAZ wire surface, so raw `console.*` there is fine.)
  {
    files: ['src/**/*.ts'],
    ignores: ['src/cert/index.ts', ...NFE_CODE_PATHS],
    rules: {
      'no-restricted-syntax': ['error', ruleBCertEnv],
    },
  },
  // Type-aware async-correctness rules. Scoped to `src/**` so the file set
  // matches this package's tsconfig `include` (`src/**/*.ts`) — the root
  // `vitest.config.ts` stays outside the typed program and is parsed by the
  // non-type-aware block above. `projectService` discovers the nearest tsconfig.
  {
    files: ['src/**/*.{ts,mts}'],
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
  // Money math must use roundReais() from @delfrance/core/money — ad-hoc
  // `.toFixed(2)` / `Math.round(x * 100)` are forbidden. The XSD string
  // serializers (`tribute/format.ts`, `generator/det.ts`) are allow-listed
  // inside the rule. Distinct rule name, so it coexists with the
  // `no-restricted-syntax` blocks above.
  {
    files: ['src/**/*.ts'],
    plugins: { delfrance: { rules: { 'no-ad-hoc-money-rounding': noAdHocMoneyRounding } } },
    rules: { 'delfrance/no-ad-hoc-money-rounding': 'error' },
  },
  // eslint-config-prettier LAST — disables stylistic rules that conflict with
  // Prettier (formatting is owned by `prettier.config.mjs` / `pnpm format`).
  eslintConfigPrettier,
];

export default config;
