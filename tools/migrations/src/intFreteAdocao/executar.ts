import {
  CAMPOS_SINCRONIZADOS,
  type DisposicaoIntFrete,
  type IntFreteEncontrado,
} from '@delfrance/data/admin/frete';

import type { MigrationContext, MigrationSummary } from '../runner';
import {
  bloqueiaAplicacao,
  contarDocsAlterados,
  divergeDoPlano,
  idsAExecutar,
  paradasDoPlano,
  registrosDoPlano,
  resumirPassagem,
  type AdocaoIntFrete,
  type ContaEscaneada,
  type LinhaConta,
  type PlanoDaPassagem,
  type RegistroJsonl,
} from './plano';

/**
 * The I/O half of every `int_frete` window adoption pass — one copy, bound per channel. Each
 * channel's dated `backfill.ts` is a thin entry point: it binds {@link executarAdocao} to its
 * {@link AdocaoIntFrete} and hands the result to the runner. What the pass does, per channel, is in
 * its runbook (`tools/migrations/<channel>-int-frete.README.md`).
 *
 * ## This file is I/O only
 *
 * The two scans, `plano.ts`, the JSONL rows. On `--apply`, each id of `idsAExecutar` goes
 * VERBATIM to the shared core's `reconciliarIntFreteDaConta` — the trigger's own binding — which
 * re-reads the conta and the doc in its own transaction and converges the doc to the conta as it
 * stands at commit. So a conta written after the scan is handled there, not here (no apply-time
 * re-read of our own), and its disposition is logged beside the planned label: a mismatch is a
 * `divergente` row. There is no clock anywhere in the pass.
 *
 * ## ⛔ STOP before the first write
 *
 * `--apply` refuses — before reconciling anything, and before a single JSONL row — while any conta
 * reports `duplicados`, a non-canonical back-ref or a doc it shares with another conta
 * (`plano.ts`). Run the dry run first and read its JSONL.
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
 * composite already declared (`integracao (tipo, …)`, `int_frete (tipo, nome)`) — plus, on
 * `--apply`, one transaction per executable conta, whose lookup query rides the channel row's
 * `int_frete (tipo, <campoBackRef>, ativo, dataCadastro DESC)`: that index must be READY first, or
 * every reconcile full-scans `int_frete`. The conta scan is masked to `tipo` + the mirrored fields,
 * so no credential is ever pulled into this process; the core's own read inside the transaction is
 * the one that decides.
 *
 * ## ⛔ Agents never run this. It runs in the migration window only — root `CLAUDE.md` rule 8.
 */

/**
 * A channel's extra READ-ONLY report, run after the plan's summary on a dry run and on
 * `--report-only` (never on `--apply`). It receives the scanned `int_frete` docs of the channel's
 * `tipo`, may read more and may log and write JSONL rows — never a Firestore write, and never a
 * STOP verdict. Resolves to the number of docs it read, added to `docsScanned`.
 */
export type AuditoriaDaPassagem = (
  ctx: MigrationContext,
  docs: ReadonlyArray<IntFreteEncontrado>,
) => Promise<number>;

export interface OpcoesDaExecucao {
  /** The runner's log name — the JSONL lands at `out/<stamp>-<nome>[-dryrun].jsonl`. */
  readonly nome: string;
  readonly auditoria?: AuditoriaDaPassagem;
}

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

/** The migration body `runMigration` runs for one channel's pass. */
export function executarAdocao(
  adocao: AdocaoIntFrete,
  opcoes: OpcoesDaExecucao,
): (ctx: MigrationContext) => Promise<MigrationSummary> {
  const { nome, auditoria } = opcoes;

  async function lerPassagem(ctx: MigrationContext): Promise<{
    plano: PlanoDaPassagem;
    docs: IntFreteEncontrado[];
    docsScanned: number;
  }> {
    const { tipoConta, tipoFrete } = adocao.sync.vinculo;
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
    const docs = docsSnap.docs.map((d) => ({
      id: d.id,
      data: d.data() as Record<string, unknown>,
    }));
    return {
      plano: adocao.planejarPassagem({ contas, docs }),
      docs,
      docsScanned: contasSnap.size + docsSnap.size,
    };
  }

  function logarResumo(plano: PlanoDaPassagem): void {
    const resumo = resumirPassagem(plano);
    const contagens = Object.entries(resumo)
      .filter(([rotulo]) => rotulo !== 'executaveis')
      .map(([rotulo, n]) => `${rotulo}=${n}`)
      .join(', ');
    log(`[${nome}] ${plano.linhas.length} conta(s): ${contagens}`);
    log(`[${nome}] ${resumo.executaveis} conta(s) com escrita planejada`);
    const paradas = paradasDoPlano(plano);
    if (bloqueiaAplicacao(paradas)) {
      log(`[${nome}] ${adocao.mensagemDeParada(paradas)}`);
    } else {
      log(`[${nome}] zero duplicados, zero back-refs não canônicos e zero docs compartilhados.`);
    }
  }

  async function aplicar(ctx: MigrationContext, plano: PlanoDaPassagem): Promise<number> {
    const linhaPorId = new Map<string, LinhaConta>(
      plano.linhas.map((l) => [l.integracaoId, l] as const),
    );
    const disposicoes: DisposicaoIntFrete[] = [];
    let divergentes = 0;
    for (const id of idsAExecutar(plano.linhas)) {
      // Through the binding object at call time — never a function taken from it at bind time.
      const disposicao = await adocao.sync.reconciliarIntFreteDaConta(ctx.db, id);
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
      `[${nome}] aplicado: ${alterados} doc(s) alterado(s) em ${disposicoes.length} ` +
        `reconciliação(ões); ${divergentes} divergente(s) do plano (grep "divergente" no JSONL).`,
    );
    log(
      `[${nome}] o "0 writes" abaixo é esperado: o núcleo escreve nas próprias ` +
        'transações, fora do BatchWriter. Rode o dry-run de novo — deve reportar 0 contas com ' +
        'escrita planejada.',
    );
    return alterados;
  }

  return async function run(ctx: MigrationContext): Promise<MigrationSummary> {
    const { plano, docs, docsScanned } = await lerPassagem(ctx);

    if (ctx.reportOnly) {
      logarResumo(plano);
      const auditados = auditoria == null ? 0 : await auditoria(ctx, docs);
      return { docsScanned: docsScanned + auditados, docsChanged: 0 };
    }

    // ⛔ Refuse before the first write — and before a single JSONL row, so nothing half-written
    // can be mistaken for a run. The message names every conta to resolve.
    const paradas = paradasDoPlano(plano);
    if (ctx.apply && bloqueiaAplicacao(paradas)) {
      throw new Error(adocao.mensagemDeParada(paradas));
    }

    for (const registro of registrosDoPlano(plano)) gravar(ctx, registro);
    logarResumo(plano);

    if (!ctx.apply) {
      const auditados = auditoria == null ? 0 : await auditoria(ctx, docs);
      return {
        docsScanned: docsScanned + auditados,
        docsChanged: idsAExecutar(plano.linhas).length,
      };
    }
    return { docsScanned, docsChanged: await aplicar(ctx, plano) };
  };
}
