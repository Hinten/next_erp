import { cargoSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the `cargos` Firestore collection. Tenant isolation
 * will land with `packages/rules-gen/` (multi-tenancy approach is being
 * redesigned — see follow-up issue).
 */
export const cargoCollection = defineCollection({
  path: 'cargos',
  schema: cargoSchema,
});
