// Library-side ESLint config. Composes the shared base — its universal TS
// parse block covers this package's `.ts`/`.mts`/`.cts` files, and
// `typeAware` supplies the type-aware async-correctness rules, so we no
// longer hand-roll either. The base's `no-restricted-syntax` (the
// repo-wide catch convention) is turned off below and the two NF-e-only
// selectors are layered back on for `src/**`.
import base, { prettier, typeAware } from '@delfrance/config-eslint';

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
  ...base,
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
  // The base's `no-restricted-syntax` carries the repo-wide catch
  // convention, which would surface ~19 pre-existing violations across
  // `src/**` + `test/**` out of scope for the pre-real-cert audit. Turn
  // it off here — the convention stays lint-enforced at the apps/*
  // boundary — and the two blocks below re-enable it with the
  // NF-e-only Rule A / Rule B selectors.
  { rules: { 'no-restricted-syntax': 'off' } },
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
  // The unified cert loader owns the cert audit channel — its greppable
  // `console.debug('[nfe-cert] …')` load-trail line is the point, so the
  // base's `no-console` (warn/error allowlist) is off here.
  {
    files: ['src/cert/index.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  // Type-aware async-correctness rules. Scoped to `src/**` so the file set
  // matches this package's tsconfig `include` (`src/**/*.ts`) — the root
  // `vitest.config.ts` stays outside the typed program and is parsed by the
  // base's non-type-aware universal block. `projectService` discovers the
  // nearest tsconfig.
  ...typeAware(import.meta.dirname, { files: ['src/**/*.{ts,mts}'] }),
  // eslint-config-prettier LAST — disables stylistic rules that conflict with
  // Prettier (formatting is owned by `prettier.config.mjs` / `pnpm format`).
  prettier,
];

export default config;
