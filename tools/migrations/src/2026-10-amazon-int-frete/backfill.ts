import { executarAdocao } from '../intFreteAdocao/executar';
import { isMainModule, runMigration } from '../runner';
import { adocaoAmazon } from './transform';

/**
 * The Amazon `int_frete` window pass (master-plan step 20, #1930; window item W12): ADOPT every
 * imported legacy freight doc of tipo `amz`, CREATE `amz-<integracaoId>` for an Amazon conta with
 * none, DEACTIVATE the docs whose conta is gone or no longer Amazon, and REPORT duplicates,
 * non-canonical back-refs and docs two contas claim. Idempotent, dry-run by default. Runbook:
 * `tools/migrations/amazon-int-frete.README.md`.
 *
 *   pnpm --filter @delfrance/migrations migrate:amazon-int-frete --project <id> --report-only   # counts only
 *   pnpm --filter @delfrance/migrations migrate:amazon-int-frete --project <id>                 # dry-run
 *   pnpm --filter @delfrance/migrations migrate:amazon-int-frete --project <id> --apply         # write
 *
 * ## Why it exists
 *
 * A Firestore import fires NO Cloud Functions trigger (root `CLAUDE.md` rule 8), so no imported
 * Amazon conta ever reaches `onIntegracaoAmazonChanged`: without this pass the migrated docs stay
 * as imported until each conta's next relevant save, and an orphan's doc stays active for good.
 * The trigger's binding has no tolerant scan either, so the `amazon` functions codebase deploys
 * only after this pass's clean second dry run (`apps/amazon/functions/DEPLOY.md`).
 *
 * ## An entry point only
 *
 * The scans, the STOP refusal, the JSONL rows and the `--apply` loop over the core are the shared
 * pass's I/O, `../intFreteAdocao/executar.ts`; the plan is `transform.ts`'s binding of
 * `../intFreteAdocao/plano.ts`. Its lookup on `--apply` rides
 * `int_frete (tipo, contaAmazonContaFreteAmazonOuterRef, ativo, dataCadastro DESC)`, which must be
 * READY first. No `mapa` audit is bound (`transform.ts` says why).
 *
 * ## Rule 7
 *
 * This file writes nothing itself, and neither do the pass's scans: they run outside any
 * transaction and decide NOTHING that is written. `--apply` hands each executable conta id,
 * verbatim, to the core's `reconciliarIntFreteDaConta(db, id)` — its ONE class-A transaction
 * (inventoried in `packages/data`), which re-reads the conta, the lookup and the deterministic id
 * and writes from those reads alone. So no precondition is needed here: a plan the live state has
 * superseded is applied as the core re-derives it, and logged as a `divergente` row. No
 * watermark, and no clock read anywhere in the pass.
 *
 * ## ⛔ Agents never run this. It runs in the migration window only — root `CLAUDE.md` rule 8.
 */

/** The runner's log name — the JSONL lands at `out/<stamp>-amazon-int-frete[-dryrun].jsonl`. */
export const NOME_DA_PASSAGEM = 'amazon-int-frete';

const run = executarAdocao(adocaoAmazon, { nome: NOME_DA_PASSAGEM });

if (isMainModule(import.meta.url)) {
  await runMigration(NOME_DA_PASSAGEM, run);
}

export { run };
