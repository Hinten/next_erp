// Flat config base. Apps and packages extend this and add framework-specific
// rules (e.g., apps/web extends with eslint-config-next).
import noInlineAdminCollection from './rules/no-inline-admin-collection.js';
import defaultQueryNeedsIndex from './rules/default-query-needs-index.js';
import noAdHocMoneyRounding from './rules/no-ad-hoc-money-rounding.js';
import noOptionalWithoutNullable from './rules/no-optional-without-nullable.js';
import noErrorAsSoleInstanceof from './rules/no-error-as-sole-instanceof.js';
import noLossyDateParse from './rules/no-lossy-date-parse.js';
import noAmbientTimezone from './rules/no-ambient-timezone.js';
import preferSchemaEnum from './rules/prefer-schema-enum.js';
import noClientEstadoHistoryWrite from './rules/no-client-estado-history-write.js';
import noEnvSecretsAccess from './rules/no-env-secrets-access.js';
import noHardcodedGcpRegion from './rules/no-hardcoded-gcp-region.js';
import noUnvalidatedResponse from './rules/no-unvalidated-response.js';
import noFocusedTest from './rules/no-focused-test.js';
import requireFirestoreDatabaseId from './rules/require-firestore-database-id.js';
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
        // Switch statements with side-effect arms (pure void returns) are not
        // caught by tsc (every arm returns void, missing arm is a no-op). This
        // rule catches missing cases at lint time. See #1095.
        //
        // ⚠️ The options are DELIBERATELY the defaults, and the one that costs
        // something is `considerDefaultExhaustiveForUnions: false`: a switch over
        // an OPEN union (`string | null`) is reported as incomplete even when a
        // `default` already answers it, so ~8 sites now name `case null` and fall
        // through. That redundancy is the price of the two gaps this rule actually
        // found — both switches HAD a `default`, so the permissive setting would
        // have missed both: the 24 unhandled `CST_PIS_COFINS` members in
        // `buildCOFINSByCST`, and the unhandled `'deleted'` in the WhatsApp
        // `processStatuses`, which was silently persisting the wrong `estadoEnvio`.
        // Flipping to `true` erases the churn and the protection together.
        //
        // ⚠️ Naming the members does NOT mean deleting the `default`. Most of
        // these switch over values read back from Firestore, where a legacy-written
        // value outside the enum is expected (rule 8) — dropping the `default`
        // turns that into a silent `undefined` return. Name the cases AND keep the
        // fallback; the rule is satisfied either way.
        '@typescript-eslint/switch-exhaustiveness-check': 'error',

        // A dead import typechecks, lints and tests green without this. Core
        // `no-unused-vars` is off in the base block (correct — it double-reports
        // on TypeScript), and the TS replacement was assumed to arrive with
        // `eslint-config-next` and never did: its FLAT export registers the
        // plugin and the parser, but the `'@typescript-eslint/no-unused-vars'`
        // entry lives in its `eslint-config-next/typescript` eslintrc export,
        // which nothing here spreads. So until #1445 there was NO unused-variable
        // detection anywhere in this repo, in either ESLint or tsc.
        //
        // #1442 is the worked example: it removed a block that used `useQuery`
        // and orphaned the import. That survived `turbo run typecheck` (28/28),
        // `turbo run lint` (30/30, zero errors) and 3013 apps/web tests, and was
        // caught by a reviewer reading the diff — which is not a mechanism.
        //
        // ERROR, not a ratchet: the pre-existing hits are fixed in the PR that
        // enables this, so there is no population to grandfather — the condition
        // this repo states for `error` (see `no-unvalidated-response` below).
        // ⚠️ And `warn` would gate NOTHING here: no lint script passes
        // `--max-warnings`, so `turbo run lint` never fails on one. Only
        // `.lintstagedrc.mjs` does, and only for files that happen to be staged.
        //
        // The `^_` patterns are the sanctioned escape hatch — this repo already
        // writes `_ctx` / `_config` / `_exhaustive` by hand.
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            args: 'after-used',
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrors: 'all',
            caughtErrorsIgnorePattern: '^_',
            destructuredArrayIgnorePattern: '^_',
            ignoreRestSiblings: true,
          },
        ],

        // An `any` silently disables every other rule in this config for the
        // value it annotates — including the `no-unsafe-*` family this file
        // deliberately does NOT enable, which is precisely what makes a stray
        // `any` the hole those rules cannot be trusted around. `unknown` plus a
        // narrowing check is the replacement, and `as unknown` is already the
        // escape `no-unvalidated-response` sanctions for network payloads.
        //
        // ERROR, same condition as above: the repo had exactly nine real `any`
        // annotations, all in one freight-br test file, and they were removed in
        // the same PR. (Every other `: any` / `as any` in a grep is the English
        // word "any" inside a comment.)
        '@typescript-eslint/no-explicit-any': 'error',
      },
    },
  ];
}

/**
 * The `no-restricted-imports` entries every workspace gets from the base block.
 *
 * Exported because flat config REPLACES a rule by name rather than merging it,
 * so an app that declares its own `no-restricted-imports` silently drops these.
 * That is not hypothetical: five backends
 * (`apps/{integrations,melhor-envio,mercado-livre,mercado-pago,whatsapp}`) each
 * added a `firebase-admin/firestore` restriction and, in doing so, turned the
 * Cloud Storage ban OFF for themselves — while the base file's own comment
 * warned about exactly that trap and only `apps/web` obeyed it. Spreading a
 * shared const is the fix a comment could not be; it mirrors the runtime
 * `baseRestrictedSyntax` reconstruction those same apps already do.
 *
 * Funnel all Cloud Storage access through the `@delfrance/storage` helpers
 * (content-addressing, dedup, the Arquivo doc, the product-scoped path
 * conventions). `getStorage()` for the singleton stays allowed.
 */
export const baseRestrictedImportPaths = [
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
];

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
          'no-client-estado-history-write': noClientEstadoHistoryWrite,
          'no-env-secrets-access': noEnvSecretsAccess,
          'no-hardcoded-gcp-region': noHardcodedGcpRegion,
          'no-lossy-date-parse': noLossyDateParse,
          'no-ambient-timezone': noAmbientTimezone,
          'no-unvalidated-response': noUnvalidatedResponse,
          'no-focused-test': noFocusedTest,
          'require-firestore-database-id': requireFirestoreDatabaseId,
        },
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Off for TYPESCRIPT only. The core rule cannot see type positions, so it
      // reports every type-only import as unused. The real gate is
      // `@typescript-eslint/no-unused-vars` in `typeAware(...)` above, plus the
      // JS-scoped re-enable of THIS rule at the bottom of this file. ⚠️ Do not
      // delete either half: with this line on its own, a dead import is
      // invisible repo-wide — which is the bug #1445 fixed.
      'no-unused-vars': 'off',
      // tsc owns undefined-identifier detection, and it knows about types,
      // `lib` globals and ambient declarations, which this rule does not.
      'no-undef': 'off',
      'no-empty': ['error', { allowEmptyCatch: false }],
      // Funnel all Cloud Storage access through the @delfrance/storage helpers.
      // ⚠️ Flat config REPLACES this rule when an app re-declares
      // `no-restricted-imports`, so any such app must SPREAD
      // `baseRestrictedImportPaths` into its own `paths` — see the const above.
      'no-restricted-imports': ['error', { paths: baseRestrictedImportPaths }],
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

      // `Date` cannot represent sub-millisecond time, and it reads an
      // offset-less string in the AMBIENT process timezone. Both cost real
      // data: `Date.parse` truncated the microseconds Django REST Framework
      // sends (which `coerceToMicros` then refilled with zeros, hiding the
      // loss), collapsing two provider updates inside the same millisecond onto
      // identical stamps so a freshness guard could not order them and the
      // stale payload won — the Loja Integrada stale-overwrite defect. And
      // apps/nfe runs TZ=America/Sao_Paulo while every other backend is UTC, so
      // an offset-less payload resolved three hours apart depending on which
      // service parsed it. `@delfrance/core/datetime` fixes both.
      //
      // Warn, not error: a ratchet over a known pre-existing population
      // (~24 non-test `Date.parse` sites), mirroring no-error-as-sole-instanceof.
      // NOTE lint-staged runs `--max-warnings 0`, so editing one of those files
      // means fixing it first. Tests and e2e helpers are exempt wholesale — an
      // ISO literal is the readable way to author a microsecond fixture.
      'delfrance/no-lossy-date-parse': 'warn',

      // The companion to the rule above: `Date.parse` was one way to read the
      // ambient process timezone, but not the only one. `apps/nfe` sets
      // TZ=America/Sao_Paulo in its App Hosting config while every other backend
      // runs UTC, so any server code that formats or reads a wall clock without
      // naming a zone produces answers three hours apart depending on which
      // service executed it — and no unit test catches it, because the runner
      // has its own third timezone.
      //
      // The scope is an INCLUDE-list of server surfaces rather than the usual
      // allow-list, and that inversion is the whole point: reading the ambient
      // zone is CORRECT in apps/web and packages/ui, where "ambient" means the
      // operator's own wall clock rather than whichever container happened to
      // run the code. Forcing those to UTC would show a human the wrong time.
      //
      // ⚠️ `@delfrance/data` is scoped by SUBPATH (`src/admin/`, `src/server/`),
      // not wholesale: `./hooks` ships `'use client'` and `./pedido` is consumed
      // from apps/web, so the package straddles both worlds.
      //
      // Warn, not error: ONE pre-existing site — apps/nfe's certificado route —
      // a user-facing string whose correct zone is a product decision (probably
      // America/Sao_Paulo, not UTC), so the rule surfaces it rather than
      // silently picking one.
      'delfrance/no-ambient-timezone': 'warn',

      // `pedidos/{id}/historicoEstadoPedido` (the pedido `estado` trail) and
      // `pedidos/{id}/historicoFtIni` (the `freteInicial.estado` trail) have
      // exactly one writer between them: the `onPedidoEstadoChanged` Cloud
      // Function, which appends a row to whichever estado moved. Both schemas
      // mark the collection `meta.serverOwned`, so the generated rules already
      // deny every client write — this rule is the fast feedback loop in front
      // of that gate.
      //
      // Error, not warn (unlike no-inline-admin-collection): there are ZERO
      // pre-existing sites to ratchet down from on either trail (neither has
      // ever had a writer outside `apps/functions`), and a hit is never stylistic —
      // it is a write that WILL fail with `permission-denied` at runtime, in a
      // place where the old code swallowed FirebaseError into a toast. Failing
      // the build beats shipping a silently missing audit row.
      'delfrance/no-client-estado-history-write': 'error',

      // `.env.secrets.example` (committed, blank) and its gitignored filled-in
      // sibling hold the repo's credential material. Nothing automated may read
      // either: a Cloud Functions deploy config ships `"ignore": ["node_modules"]`
      // and nothing else, so anything a predeploy hook writes into the artifact is
      // uploaded to the project's `gcf-sources-*` bucket AND baked in plaintext into
      // the Cloud Run revision. This rule is deliberately enabled HERE, in the base
      // block, and not inside `typeAware(...)`: that block is `files`-scoped to
      // `**/*.{ts,tsx,mts,cts}`, which would silently exclude the five
      // `prepare-deploy.mjs` scripts — the exact files this guards.
      //
      // Error, not warn: zero pre-existing sites, and the failure mode is
      // credential material reaching a cloud bucket, not a style nit. The non-JS
      // surface ESLint cannot parse (workflows, firebase configs, shell scripts) is
      // covered by `rules/env-secrets-no-copy.test.js`.
      'delfrance/no-env-secrets-access': 'error',

      // A Google Cloud region must come from the environment, never a literal.
      // ERROR, not a ratchet: the sweep that removed the last 30 sites landed
      // first, so there is no pre-existing population to grandfather — and the
      // failure it guards is silent. A function deployed to the wrong region
      // deploys fine, and an enqueue against the wrong one is DROPPED while the
      // route still returns 200 (#1108); the bill was the first signal that this
      // repo had drifted into three regions.
      'delfrance/no-hardcoded-gcp-region': 'error',

      // Never assert a type onto a value that came off the network. Six
      // near-identical HTTP clients ended in `return parsed as T`, so on any 2xx
      // the caller got whatever arrived wearing a type nobody verified — and the
      // three failure modes were all SILENT: a wrong shape came back cast, an
      // empty body came back as `null as T`, and a proxy's HTML came back as
      // `{error: '<html>…'}`, a truthy object that sailed through `if (conta)`.
      // That is what reported a mint as successful while it had reused two
      // accounts and wiped a credential (#1295 -> #1302).
      //
      // ERROR, not a ratchet: the sweep that removed all six landed first, so
      // there is no pre-existing population to grandfather — the condition this
      // repo states for `error` (see the `warn` entries above).
      //
      // Two shapes, both syntactic: a cast directly on `JSON.parse(…)`/`.json()`,
      // and a cast to a TYPE PARAMETER of a function that also performs HTTP.
      // The second is scoped to HTTP functions on purpose — `snap.data() as T`
      // on a Firestore snapshot is the identical shape and perfectly correct.
      // `as unknown` is the sanctioned escape; the rule header explains the rest,
      // including the three things it deliberately cannot catch.
      'delfrance/no-unvalidated-response': 'error',

      // A committed `.only` does not fail anything — it stops the rest of its
      // file from running while every reporter, and the CI gate in front of it,
      // still say PASS. Playwright's `forbidOnly` defaults to FALSE and
      // apps/web's config did not set it, so one `test.only` in any of the 62
      // e2e specs would have taken an `E2E gate` check green over a suite that
      // had stopped running. Vitest is safer only by an UNDECLARED upstream
      // default (`allowOnly: !process.env.CI`), which nothing here asserts.
      //
      // ERROR, zero pre-existing sites: the only `.only` in the repo is the
      // `RuleTester.itOnly = it.only` wiring, which is a reference rather than a
      // call and so never reports. The runner flags fail the RUN; this fails the
      // COMMIT, which is where a fix is cheapest.
      'delfrance/no-focused-test': 'error',

      // The database on this Enterprise project is named `default`, not the
      // `(default)` sentinel a 0-/1-argument `getFirestore()` resolves — so a
      // bare call yields a handle whose every operation fails `5 NOT_FOUND`,
      // far from the line that made it.
      //
      // ERROR, zero pre-existing sites — but the convention is currently held by
      // SEVEN copies of the same `admin.ts` across five codebases, each carrying
      // its own prose warning. That is exactly the "these five agree" shape this
      // repo writes guards for.
      'delfrance/require-firestore-database-id': 'error',
    },
  },

  // The TypeScript half of the unused-variable gate lives in `typeAware(...)`,
  // whose `files` glob is TS-only. That silently excludes the plain-JS surface
  // this repo actually has: every custom rule and backstop under
  // `packages/config-eslint/rules`, `tools/deploy-env`, `packages/config-vitest`,
  // the five `apps/*/functions/scripts/prepare-deploy.mjs` and their `build.mjs`.
  //
  // This is the same asymmetry that put `delfrance/no-env-secrets-access` in the
  // base block rather than in `typeAware(...)` — see its entry above, which
  // spells out that typeAware's scoping "would silently exclude the five
  // prepare-deploy.mjs scripts".
  //
  // Scoped to JS so TypeScript keeps getting ONLY the typescript-eslint rule:
  // the core rule double-reports on TS and misreads type-only usage, which is
  // exactly why it is `off` in the block above.
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
];

export default config;
