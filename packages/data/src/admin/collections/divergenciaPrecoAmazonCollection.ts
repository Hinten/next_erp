import { divergenciaPrecoAmazonSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the parts of one Amazon price run —
 * `precosAmazon/{contaId}/divergenciasPrecoAmazon/{execucaoId}-{n}` (step 13),
 * doc id `idDivergenciaPrecoAmazon(execucaoId, n)`: the sendable SKUs of the
 * n-th page that found one (parts are numbered DENSELY), each with the link
 * path, the unit, the offer and faixa the page saw, the listing's
 * `productType` and the read instant.
 *
 * Written by the page holding the run, with a full overwrite BEFORE the run's
 * own update, so a retried page that recomputed its live reads replaces the
 * part it is about to count. Read by id — the deterministic ids
 * `0…proximaParte−1` of one run — NEVER queried, so it needs no index.
 *
 * ⚠️ Every part carries `expiraEm` (a real `Date`, required by the schema); the
 * TTL policy on the `divergenciasPrecoAmazon` group is a `TTL_POLICIES` row
 * plus its `fieldOverrides` entry in `firestore.indexes.json`. Declared ahead
 * of its writer: nothing writes here yet.
 *
 * Same admin-only / default-deny posture as the parent run.
 */
export const divergenciaPrecoAmazonCollection = defineAdminCollection({
  path: 'precosAmazon/{contaId}/divergenciasPrecoAmazon',
  schema: divergenciaPrecoAmazonSchema,
});
