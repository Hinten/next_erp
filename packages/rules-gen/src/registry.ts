import type { z } from 'zod';
import type { DomainSchema } from '@delfrance/schemas';
import { ALL_DOMAINS } from '@delfrance/schemas';
import { GRUPO_ECONOMICO_COLLECTION_PATH } from '@delfrance/core/tenant';

/** Every schema-backed domain the generator emits match blocks for. */
export const DOMAINS: ReadonlyArray<DomainSchema<z.ZodTypeAny>> = ALL_DOMAINS;

/**
 * Field-validator whitelist, by collectionPath. The old Flutter generator hit
 * the 256 KiB compiled-ruleset deploy limit emitting validators for every
 * collection and recovered by validating only the critical ones — we start
 * there. Everything else still gets permission checks, just no field clauses.
 */
export const VALIDATOR_WHITELIST: ReadonlySet<string> = new Set([
  'clientes',
  'produtos',
  'pedidos',
  'pedidos/{pedidoId}/pagamento',
  'metodo_pgto',
]);

/**
 * Hand-written match blocks for collections without a DomainSchema.
 *
 * grupoEconomico: the tenant registry. Every signed-in user reads their own
 * grupo doc (useTenant reads the `grupoEconomico` claim and fetches that id);
 * there are no client writes — the Flutter/admin side manages tenants.
 */
export const EXTRA_MATCH_BLOCKS: ReadonlyArray<{ path: string; body: ReadonlyArray<string> }> = [
  {
    path: `${GRUPO_ECONOMICO_COLLECTION_PATH}/{grupoId}`,
    body: [
      "allow read: if request.auth != null && request.auth.token.get('grupoEconomico', '') == grupoId;",
    ],
  },
];

/**
 * STAGING-ONLY match block, appended only when generating with `--e2e`
 * (`firestore.e2e.rules`, deployed via `firebase.staging.json`). The Playwright
 * fixtures isolate each run in top-level collections named
 * `e2e_<runId>_<collection>` (`tools/test-fixtures/src/admin.ts` → `namespace()`),
 * which the fixed-path production rules default-deny — that is exactly what broke
 * e2e when the generated ruleset was deployed to staging (#160). This grants the
 * authenticated ephemeral test user full access to any `e2e_`-prefixed namespace
 * and everything under it. It is inert for real collections (the regex only
 * matches the `e2e_` prefix) and is NEVER emitted into the production ruleset.
 */
export const E2E_NAMESPACE_BLOCK: { path: string; body: ReadonlyArray<string> } = {
  path: '{nsColl}/{document=**}',
  body: ["allow read, write: if request.auth != null && nsColl.matches('^e2e_[0-9A-Za-z_]+$');"],
};
