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
