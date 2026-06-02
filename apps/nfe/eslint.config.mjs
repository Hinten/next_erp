import base from '@delfrance/config-eslint';
import next from 'eslint-config-next';

// Rule A — no multi-arg `console.*` in NF-e code paths. The single-arg
// text-only forms (`console.debug(\`msg ${var}\`)`, `console.warn(\`msg\`)`)
// stay legal — they're how the orchestrator emits diagnostic markers
// today. The multi-arg shapes are exactly the P1 leak pattern
// (`console.error('[nfe/x]', e)`, `console.log('label', obj)`) that dump
// unsanitized values via Node's `util.inspect` — and that enumeration
// fires identically for log/info/warn/error/debug, so all five are
// guarded. Use `safeLog('error', label, err)` instead — it runs every
// arg through `redactSensitive` first.
const ruleAConsole = {
  selector:
    'CallExpression[callee.object.name="console"][callee.property.name=/^(log|info|warn|error|debug)$/][arguments.length>=2]',
  message:
    'Multi-arg console.* is forbidden in NF-e code paths — ' +
    'that is the original P1 leak shape (label + raw object). Use ' +
    'safeLog(level, ...) from @/lib/nfe/log or compose a single template ' +
    'string. safeLog routes every arg through redactSensitive first.',
};

// Rule B — `NFE_CERT_*` env vars may only be READ inside the unified
// loader at `packages/integrations/nfe/src/cert/index.ts`.
const ruleBCertEnv = {
  selector:
    'MemberExpression[property.name=/^NFE_CERT_(BASE64|PATH|PASSWORD)$/]',
  message:
    'NFE_CERT_BASE64 / NFE_CERT_PATH / NFE_CERT_PASSWORD may only be ' +
    'read inside packages/integrations/nfe/src/cert/index.ts. Call ' +
    'loadCertificateFromEnv() or hasNFeCertEnv() from ' +
    '@delfrance/integrations-nfe instead.',
};

// Rule C — no raw Firestore ref construction. Admin refs are built via
// METHODS (`db.collection()`, `db.doc()`, `db.collectionGroup()`), which
// `no-restricted-imports` can't catch, so ban the method calls. Every NF-e
// document write must go through a schema-validated `defineAdminCollection`
// handle in `lib/data` (`nfev4Collection`, `nfeConfigCollection`,
// `enviNfeMsgCollection`). Legitimate raw READS (dynamic outer-ref derefs and
// legacy-named subcollections) carry a scoped inline eslint-disable.
const ruleCNoRawFirestoreRefs = [
  {
    selector: "CallExpression[callee.property.name='collection']",
    message:
      'Do not build raw Firestore refs with `.collection()`. Use a defineAdminCollection() handle from `@/lib/data/*` — it validates writes against the Zod schema.',
  },
  {
    selector: "CallExpression[callee.property.name='doc']",
    message:
      'Do not build raw Firestore refs with `.doc()`. Use a defineAdminCollection() handle (`xCollection.docRef(fs, ctx, id)` / `.set` / `.merge` / `.add`).',
  },
  {
    selector: "CallExpression[callee.property.name='collectionGroup']",
    message:
      'Do not build raw Firestore refs with `.collectionGroup()`. Use a defineAdminCollection() handle (`xCollection.groupQuery(fs)`).',
  },
];

const config = [
  ...base,
  ...next,
  {
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
  // Flat config does full-replacement, not merging, for the same rule
  // across matching config blocks. So when two blocks both set
  // `no-restricted-syntax`, the LAST one wins for files matching both.
  // To keep both Rule A and Rule B firing in NF-e paths, we combine
  // them in a single block scoped to those paths.
  //
  // NF-e paths — Rule A (no raw console.*) + Rule B (no NFE_CERT_* reads).
  // `lib/nfe/log.ts` is the implementation of the safe wrappers and uses
  // raw `console[level]` internally with an inline eslint-disable.
  {
    files: ['lib/nfe/**/*.ts', 'app/api/nfe/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ruleAConsole,
        ruleBCertEnv,
        ...ruleCNoRawFirestoreRefs,
      ],
    },
  },
  // Non-NF-e app paths — Rule B only. Console-* is unrestricted outside
  // NF-e code paths (still subject to the base config's `no-console`
  // warn allowing warn/error).
  {
    files: ['lib/**/*.ts', 'app/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['lib/nfe/**/*.ts', 'app/api/nfe/**/*.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ruleBCertEnv, ...ruleCNoRawFirestoreRefs],
    },
  },
];

export default config;
