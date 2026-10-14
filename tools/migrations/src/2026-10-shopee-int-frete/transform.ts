import { intFreteContaSync } from '@delfrance/data/admin/frete';
import { VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

import { adocaoIntFrete } from '../intFreteAdocao/plano';

/**
 * The Shopee binding of the shared `int_frete` window adoption pass (#1528, master-plan step 20).
 * Runbook: `tools/migrations/shopee-int-frete.README.md`; the entry point is `backfill.ts`.
 *
 * The plan itself — the labels, the STOP verdict, the JSONL rows — is ONE copy for every channel,
 * in `../intFreteAdocao/plano.ts`, and decides nothing of its own either: every create / patch /
 * deactivate verdict comes from the shared core's planner and chooser through {@link syncShopee},
 * the SAME zero-option binding the `onIntegracaoShopeeChanged` trigger runs (#1369). This file only
 * binds that pass to the Shopee row and keeps every name the Shopee pass has always exported, so
 * `transform.test.ts` — unedited since the extraction — stays the behavioural pin.
 */

/** The Shopee binding — zero options, exactly the trigger's (no tolerant scan). */
export const syncShopee = intFreteContaSync(VINCULO_INT_FRETE_CONTA.shopee);

/** The shared pass, bound to {@link syncShopee}. */
export const adocaoShopee = adocaoIntFrete(syncShopee, { runbook: 'shopee-int-frete.README.md' });

export const { contaIdDoRef, planejarPassagem, mensagemDeParada } = adocaoShopee;

export {
  ROTULOS_CONTA,
  bloqueiaAplicacao,
  contarDocsAlterados,
  divergeDoPlano,
  idsAExecutar,
  paradasDoPlano,
  registrosDoPlano,
  resumirPassagem,
  type ContaEscaneada,
  type LinhaConta,
  type ParadasDoPlano,
  type PlanoDaPassagem,
  type RefIlegivel,
  type RegistroJsonl,
  type ResumoDaPassagem,
  type RotuloConta,
} from '../intFreteAdocao/plano';
