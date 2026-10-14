import { TIPOS_ALVO_MAPA_FRETE_LI } from '@delfrance/schemas';

import { executarAdocao, type AuditoriaDaPassagem } from '../intFreteAdocao/executar';
import { isMainModule, runMigration } from '../runner';
import { CAMPOS_DA_AUDITORIA, adocaoLojaIntegrada, auditarMapa } from './transform';

/**
 * The Loja Integrada `int_frete` window pass (master-plan step 20, #1826): ADOPT every imported
 * per-conta freight doc (`int_frete` of tipo `lojaIntegrada`), CREATE `lojaIntegrada-<integracaoId>`
 * for a Loja Integrada conta with none, DEACTIVATE the docs whose conta is gone or no longer Loja
 * Integrada, and REPORT duplicates, non-canonical back-refs and docs two contas claim. Idempotent,
 * dry-run by default. Runbook: `tools/migrations/li-int-frete.README.md`.
 *
 *   pnpm --filter @delfrance/migrations migrate:li-int-frete --project <id>                 # dry-run
 *   pnpm --filter @delfrance/migrations migrate:li-int-frete --project <id> --report-only   # counts only
 *   pnpm --filter @delfrance/migrations migrate:li-int-frete --project <id> --apply         # write
 *
 * ## Why it exists
 *
 * A Firestore import fires NO Cloud Functions trigger (root `CLAUDE.md` rule 8), so no imported
 * Loja Integrada conta ever reaches `onIntegracaoLojaIntegradaChanged`: without this pass the
 * migrated docs stay as imported until each conta's next relevant save, and an orphan's doc stays
 * active for good. The trigger's binding has no tolerant scan either, so a migrated doc whose
 * back-ref is not canonical would be invisible to it — the pass reports that, once, instead.
 *
 * ## An entry point only
 *
 * The scans, the STOP refusal, the JSONL rows and the `--apply` loop over the core are the shared
 * pass's I/O, `../intFreteAdocao/executar.ts`; the plan is `transform.ts`'s binding of
 * `../intFreteAdocao/plano.ts`. Its lookup on `--apply` rides
 * `int_frete (tipo, contaLojaIntegradaEnviosOuterRef, ativo, dataCadastro DESC)`, which must be
 * READY first.
 *
 * What this file adds is {@link auditoriaDoMapa}: on a dry run and on `--report-only`, one more
 * read — the ids (and nothing else) of the `int_frete` docs of the five target tipos, on the `tipo`
 * prefix of `int_frete (tipo, nome)` — and the read-only `mapa` counts of `transform.ts`.
 *
 * ## ⛔ Agents never run this. It runs in the migration window only — root `CLAUDE.md` rule 8.
 */

/** The runner's log name — the JSONL lands at `out/<stamp>-li-int-frete[-dryrun].jsonl`. */
export const NOME_DA_PASSAGEM = 'li-int-frete';

function log(message: string): void {
  // eslint-disable-next-line no-console -- operator-facing run output
  console.log(message);
}

/**
 * The read-only `mapa` audit: counts, never a STOP verdict and never a write. Masked to the doc ids
 * (an empty `select()`), so no target's credential — a Melhor Envio doc carries its OAuth app's
 * `client_secret` — is ever pulled into this process. On a dry run it also writes ONE
 * `auditoria-mapa` JSONL row.
 */
export const auditoriaDoMapa: AuditoriaDaPassagem = async (ctx, docs) => {
  const alvosSnap = await ctx.db
    .collection('int_frete')
    .where('tipo', 'in', [...TIPOS_ALVO_MAPA_FRETE_LI])
    .select()
    .get();
  const auditoria = auditarMapa({ docs, idsDosAlvos: alvosSnap.docs.map((d) => d.id) });
  const contagens = CAMPOS_DA_AUDITORIA.map((campo) => `${campo}=${auditoria[campo]}`).join(', ');
  log(
    `[${NOME_DA_PASSAGEM}] auditoria do mapa (só leitura, nunca um STOP; ${alvosSnap.size} ` +
      `destino(s) lidos): ${contagens}`,
  );
  if (!ctx.reportOnly) {
    ctx.sink.skip('int_frete', 'auditoria-mapa', auditoria, 'auditoria-mapa');
  }
  return alvosSnap.size;
};

const run = executarAdocao(adocaoLojaIntegrada, {
  nome: NOME_DA_PASSAGEM,
  auditoria: auditoriaDoMapa,
});

if (isMainModule(import.meta.url)) {
  await runMigration(NOME_DA_PASSAGEM, run);
}

export { run };
