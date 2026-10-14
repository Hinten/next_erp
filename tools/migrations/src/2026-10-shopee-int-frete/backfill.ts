import { CAMPOS_SINCRONIZADOS, type DisposicaoIntFrete } from '@delfrance/data/admin/frete';

import {
  isMainModule,
  type MigrationContext,
  type MigrationSummary,
  runMigration,
} from '../runner';
import {
  bloqueiaAplicacao,
  contarDocsAlterados,
  divergeDoPlano,
  idsAExecutar,
  mensagemDeParada,
  paradasDoPlano,
  planejarPassagem,
  registrosDoPlano,
  resumirPassagem,
  syncShopee,
  type ContaEscaneada,
  type LinhaConta,
  type PlanoDaPassagem,
  type RegistroJsonl,
} from './transform';

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
 * ## This file is I/O only
 *
 * The two scans, `transform.ts`, the JSONL rows. On `--apply`, each id of `idsAExecutar` goes
 * VERBATIM to the shared core's `reconciliarIntFreteDaConta` — the trigger's own binding — which
 * re-reads the conta and the doc in its own transaction and converges the doc to the conta as it
 * stands at commit. So a conta written after the scan is handled there, not here (no apply-time
 * re-read of our own), and its disposition is logged beside the planned label: a mismatch is a
 * `divergente` row. There is no clock anywhere in the pass.
 *
 * ## ⛔ STOP before the first write
 *
 * `--apply` refuses — before reconciling anything — while any conta reports `duplicados`, a
 * non-canonical back-ref or a doc it shares with another conta (`transform.ts`). Run the dry run
 * first and read its JSONL.
 *
 * ## `writes 0` is expected
 *
 * The core writes in its own transactions, never through the runner's `BatchWriter`, so the
 * runner's closing `… 0 writes` figure is 0 BY DESIGN. `docsChanged` (the applied
 * `criado` / `atualizado` / `desativado` dispositions) and the JSONL are the record.
 *
 * ## Cost
 *
 * Two equality scans over small populations (one doc per conta), each on the `tipo` prefix of a
 * composite already declared before step 20 (`integracao (tipo, …)`, `int_frete (tipo, nome)`) —
 * plus, on `--apply`, one transaction per executable conta, whose lookup query rides step 20's
 * `int_frete (tipo, contaShopeeFreteOuterRef, ativo, dataCadastro DESC)`: #1532 must be READY
 * first, or every reconcile full-scans `int_frete`. The conta scan is masked to `tipo` + the
 * mirrored fields, so no credential is ever pulled into this process; the core's own read inside
 * the transaction is the one that decides.
 *
 * ## ⛔ Agents never run this. It runs in the migration window only — root `CLAUDE.md` rule 8.
 */

/** The runner's log name — the JSONL lands at `out/<stamp>-shopee-int-frete[-dryrun].jsonl`. */
export const NOME_DA_PASSAGEM = 'shopee-int-frete';

function log(message: string): void {
  // eslint-disable-next-line no-console -- operator-facing run output
  console.log(message);
}

function gravar(ctx: MigrationContext, registro: RegistroJsonl): void {
  if (registro.kind === 'change') {
    ctx.sink.change(registro.path, registro.field, registro.from, registro.to);
  } else {
    ctx.sink.skip(registro.path, registro.field, registro.value, registro.reason);
  }
}

async function lerPassagem(ctx: MigrationContext): Promise<{
  plano: PlanoDaPassagem;
  docsScanned: number;
}> {
  const { tipoConta, tipoFrete } = syncShopee.vinculo;
  const [contasSnap, docsSnap] = await Promise.all([
    ctx.db
      .collection('integracao')
      .where('tipo', '==', tipoConta)
      .select('tipo', ...CAMPOS_SINCRONIZADOS)
      .get(),
    ctx.db.collection('int_frete').where('tipo', '==', tipoFrete).get(),
  ]);
  const contas: ContaEscaneada[] = contasSnap.docs.map((d) => ({
    id: d.id,
    data: d.data() as Record<string, unknown>,
  }));
  const docs = docsSnap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
  return {
    plano: planejarPassagem({ contas, docs }),
    docsScanned: contasSnap.size + docsSnap.size,
  };
}

function logarResumo(plano: PlanoDaPassagem): void {
  const resumo = resumirPassagem(plano);
  const contagens = Object.entries(resumo)
    .filter(([rotulo]) => rotulo !== 'executaveis')
    .map(([rotulo, n]) => `${rotulo}=${n}`)
    .join(', ');
  log(`[${NOME_DA_PASSAGEM}] ${plano.linhas.length} conta(s): ${contagens}`);
  log(`[${NOME_DA_PASSAGEM}] ${resumo.executaveis} conta(s) com escrita planejada`);
  const paradas = paradasDoPlano(plano);
  if (bloqueiaAplicacao(paradas)) {
    log(`[${NOME_DA_PASSAGEM}] ${mensagemDeParada(paradas)}`);
  } else {
    log(
      `[${NOME_DA_PASSAGEM}] zero duplicados, zero back-refs não canônicos e zero docs ` +
        'compartilhados.',
    );
  }
}

async function aplicar(ctx: MigrationContext, plano: PlanoDaPassagem): Promise<number> {
  const linhaPorId = new Map<string, LinhaConta>(
    plano.linhas.map((l) => [l.integracaoId, l] as const),
  );
  const disposicoes: DisposicaoIntFrete[] = [];
  let divergentes = 0;
  for (const id of idsAExecutar(plano.linhas)) {
    const disposicao = await syncShopee.reconciliarIntFreteDaConta(ctx.db, id);
    disposicoes.push(disposicao);
    const linha = linhaPorId.get(id);
    const path = `integracao/${id}`;
    ctx.sink.change(path, 'aplicado', linha?.rotulo ?? null, disposicao);
    if (linha == null || divergeDoPlano(linha, disposicao)) {
      divergentes += 1;
      ctx.sink.skip(
        path,
        'divergente',
        { planejado: linha?.rotulo ?? null, intFreteId: linha?.intFreteId ?? null, disposicao },
        'divergente',
      );
    }
  }
  const alterados = contarDocsAlterados(disposicoes);
  log(
    `[${NOME_DA_PASSAGEM}] aplicado: ${alterados} doc(s) alterado(s) em ${disposicoes.length} ` +
      `reconciliação(ões); ${divergentes} divergente(s) do plano (grep "divergente" no JSONL).`,
  );
  log(
    `[${NOME_DA_PASSAGEM}] o "0 writes" abaixo é esperado: o núcleo escreve nas próprias ` +
      'transações, fora do BatchWriter. Rode o dry-run de novo — deve reportar 0 contas com ' +
      'escrita planejada.',
  );
  return alterados;
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  const { plano, docsScanned } = await lerPassagem(ctx);

  if (ctx.reportOnly) {
    logarResumo(plano);
    return { docsScanned, docsChanged: 0 };
  }

  // ⛔ Refuse before the first write — and before a single JSONL row, so nothing half-written
  // can be mistaken for a run. The message names every conta to resolve.
  const paradas = paradasDoPlano(plano);
  if (ctx.apply && bloqueiaAplicacao(paradas)) {
    throw new Error(mensagemDeParada(paradas));
  }

  for (const registro of registrosDoPlano(plano)) gravar(ctx, registro);
  logarResumo(plano);

  if (!ctx.apply) {
    return { docsScanned, docsChanged: idsAExecutar(plano.linhas).length };
  }
  return { docsScanned, docsChanged: await aplicar(ctx, plano) };
}

if (isMainModule(import.meta.url)) {
  await runMigration(NOME_DA_PASSAGEM, run);
}

export { run };
