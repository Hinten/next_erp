import { executarAdocao } from '../intFreteAdocao/executar';
import { isMainModule, runMigration } from '../runner';
import { adocaoShopee } from './transform';

/**
 * The Shopee `int_frete` window pass (#1528, master-plan step 20): ADOPT every imported legacy
 * `FreteShopee` doc, CREATE `shopee-<integracaoId>` for a Shopee conta with none, DEACTIVATE the
 * docs whose conta is gone or no longer Shopee, and REPORT duplicates, non-canonical back-refs and
 * docs two contas claim. Idempotent, dry-run by default. Runbook: `tools/migrations/shopee-int-frete.README.md`.
 *
 *   pnpm --filter @delfrance/migrations migrate:shopee-int-frete --project <id>                 # dry-run
 *   pnpm --filter @delfrance/migrations migrate:shopee-int-frete --project <id> --report-only   # counts only
 *   pnpm --filter @delfrance/migrations migrate:shopee-int-frete --project <id> --apply         # write
 *
 * ## Why it exists
 *
 * A Firestore import fires NO Cloud Functions trigger (root `CLAUDE.md` rule 8), so no imported
 * Shopee conta ever reaches `onIntegracaoShopeeChanged`: without this pass the migrated docs stay
 * as imported until each conta's next relevant save, and an orphan's doc stays active for good.
 *
 * ## An entry point only
 *
 * The scans, the STOP refusal, the JSONL rows and the `--apply` loop over the core are the shared
 * pass's I/O, `../intFreteAdocao/executar.ts`; the plan is `transform.ts`'s binding of
 * `../intFreteAdocao/plano.ts`. Its lookup on `--apply` rides #1532's
 * `int_frete (tipo, contaShopeeFreteOuterRef, ativo, dataCadastro DESC)`, which must be READY
 * first.
 *
 * ## ⛔ Agents never run this. It runs in the migration window only — root `CLAUDE.md` rule 8.
 */

/** The runner's log name — the JSONL lands at `out/<stamp>-shopee-int-frete[-dryrun].jsonl`. */
export const NOME_DA_PASSAGEM = 'shopee-int-frete';

const run = executarAdocao(adocaoShopee, { nome: NOME_DA_PASSAGEM });

if (isMainModule(import.meta.url)) {
  await runMigration(NOME_DA_PASSAGEM, run);
}

export { run };
