import { cargoSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the `cargos` Firestore collection. Tenant isolation is
 * enforced at query time by filtering on `grupoEconomico` (Firestore rules
 * will be the security boundary once `packages/rules-gen/` lands).
 */
export const cargoCollection = defineCollection({
  path: 'cargos',
  schema: cargoSchema,
});
