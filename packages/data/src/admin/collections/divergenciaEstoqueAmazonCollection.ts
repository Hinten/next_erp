import { divergenciaEstoqueAmazonSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the drift blocks of one Amazon stock reconcile run —
 * `reconciliacaoEstoqueAmazon/{contaId}/divergenciasEstoqueAmazon/{execucaoId}-{n}`
 * (step 12), doc id `idDivergenciaEstoqueAmazon(execucaoId, n)`: the drift that
 * walk page `n` found, with the depósito the walk read.
 *
 * Written by the page holding the run, with a full overwrite BEFORE the page's state
 * update, so a retried page that recomputed its live reads replaces the block
 * it is about to count (a `create` would keep the old block under the new
 * counters). Read by id — the deterministic ids `0…partes−1` of one run —
 * NEVER queried, so it needs no index.
 *
 * ⚠️ Every block carries `expiraEm` (a real `Date`, required by the schema). The
 * TTL policy on the `divergenciasEstoqueAmazon` group is declared together with
 * the blocks' writer; until then nothing writes here.
 *
 * Same admin-only / default-deny posture as the parent run.
 */
export const divergenciaEstoqueAmazonCollection = defineAdminCollection({
  path: 'reconciliacaoEstoqueAmazon/{contaId}/divergenciasEstoqueAmazon',
  schema: divergenciaEstoqueAmazonSchema,
});
