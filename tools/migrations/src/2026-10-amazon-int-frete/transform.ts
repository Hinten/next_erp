import { intFreteContaSync } from '@delfrance/data/admin/frete';
import { VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

import { adocaoIntFrete } from '../intFreteAdocao/plano';

/**
 * The Amazon binding of the shared `int_frete` window adoption pass (master-plan step 20, #1930;
 * window item W12). Runbook: `tools/migrations/amazon-int-frete.README.md`; the entry point is
 * `backfill.ts`.
 *
 * The plan itself — the labels, the STOP verdict, the JSONL rows — is ONE copy for every channel,
 * in `../intFreteAdocao/plano.ts`, and decides nothing of its own either: every create / patch /
 * deactivate verdict comes from the shared core's planner and chooser through {@link syncAmazon}.
 * That binding equals the `onIntegracaoAmazonChanged` trigger's (`apps/amazon/lib/amazon/frete/intFrete.ts`):
 * the same row, `VINCULO_INT_FRETE_CONTA.amazon` (freight tipo `amz`, new docs at
 * `amz-<integracaoId>`), and the same ZERO options, so no tolerant scan. This package has no
 * dependency edge to `apps/amazon`, so it binds the row itself rather than import that constant;
 * `transform.test.ts` pins both facts (#1369: one core, and one row, never a second rule).
 *
 * No `mapa` audit, unlike Loja Integrada's pass: the legacy Amazon code never reads `mapa`,
 * `faixaCep` or `horarioDeCorte` on its freight doc, so the counts would report on nothing.
 */

/** The Amazon binding — zero options, exactly the trigger's (no tolerant scan). */
export const syncAmazon = intFreteContaSync(VINCULO_INT_FRETE_CONTA.amazon);

/** The shared pass, bound to {@link syncAmazon}. */
export const adocaoAmazon = adocaoIntFrete(syncAmazon, { runbook: 'amazon-int-frete.README.md' });

export const { contaIdDoRef, planejarPassagem, mensagemDeParada } = adocaoAmazon;

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
