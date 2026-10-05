/**
 * Rehearse the WEEKLY Shopee settlement sweep from the command line (#1514,
 * step 6).
 *
 *   pnpm --filter @delfrance/shopee-app liquidar:pagamentos --integracao int-1
 *
 * ## Why this exists
 *
 * `sweepShopeeEscrowSettlement` runs once a week, unattended, on a schedule
 * nobody can trigger on demand — and it is the ONLY thing in this channel that
 * ever writes what the marketplace really paid. So the first settlement this
 * channel ever performs would otherwise happen on a Monday at 05:10, against
 * whatever `get_escrow_list` decided to return, with nobody watching. This
 * script makes that first write a deliberate, observable act against one named
 * integração, before the migration window (root CLAUDE.md rule 8).
 *
 * ⚠️ **Dev-only, and never run by an agent.** In `--live` it updates real
 * `pedidos/{id}/pagamentos/{id}` documents.
 *
 * ## The two modes
 *
 * **`--dry-run` (the DEFAULT)** calls Shopee (`get_escrow_list`, then
 * `get_escrow_detail` per row), reads the pagamento of each row and prints what
 * a live tick WOULD change. It writes nothing, and that is structural rather
 * than a promise: it calls `simularLiquidacaoShopee`, whose body contains no
 * writer at all, and whose verdict comes from the SAME `preverLiquidacaoShopee`
 * the transaction uses.
 *
 * **`--live`** calls `runShopeeEscrowSettlement` exactly as the schedule does,
 * scoped to one integração. The cursor document is NOT written unless `--cursor`
 * is passed, so a rehearsal cannot silently advance a conta's week.
 *
 * ⚠️ **Both modes reach Shopee** and spend the same rate-limited calls.
 *
 * ## What it prints, and what it must never print
 *
 * Every row goes through `lib/shopee/pedidos/liquidarPagamentosCli.ts`, whose
 * summary is an ALLOW-LIST of thirteen fields. The escrow body it is built from
 * carries ~100 money fields plus `buyer_payment_info`; the buyer has no field to
 * travel in. A terminal transcript gets pasted into issues — the SVC-AN incident
 * (a `xMotivo` log that leaked a CNPJ into a public log) is the local precedent.
 *
 * ## Exit codes
 *
 * `0` on ANY settlement outcome, including `ignorado-sem-pagamento` and
 * `ignorado-obsoleto` — those are answers, not failures. `1` only on a throw,
 * described by CLASS plus Shopee's `code`/`message` and never a payload.
 */
import {
  ArgumentoInvalidoError,
  USO_LIQUIDAR_PAGAMENTOS,
  carimboMs,
  descreverErroLiquidacao,
  parseArgsLiquidarPagamentos,
  renderResumoLiquidacao,
  resumoDaLinhaSimulada,
} from '../lib/shopee/pedidos/liquidarPagamentosCli';

/** stdout — the report. */
function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

/**
 * stderr — the preamble and the warnings.
 *
 * ⚠️ Why a second stream: under `--json` the stdout must stay a single parseable
 * document, and the mode/project/database preamble still has to reach the human
 * BEFORE anything happens.
 */
function aviso(message: string): void {
  console.error(message);
}

async function main(): Promise<void> {
  const comando = parseArgsLiquidarPagamentos(process.argv.slice(2));
  if (comando.kind === 'ajuda') {
    log(USO_LIQUIDAR_PAGAMENTOS);
    return;
  }
  const { integracaoId, janela, orderSn, live, cursor, json, projectId } = comando.args;

  // ⚠️ The dynamic imports are what make "`--help` touches no environment and no
  // Firestore" STRUCTURAL instead of a claim: nothing below this line has been
  // loaded yet, so no module-level env read, admin singleton or client
  // construction can run on the help path. They also keep `--project` effective
  // — the admin app resolves its project id once, at first use.
  if (projectId != null) process.env.FIREBASE_PROJECT_ID = projectId;

  const { getAdminApp, getAdminFirestore } = await import('../lib/firebase/admin');
  const { loadShopeeContext } = await import('../lib/shopee/core/shopee');
  const { createShopeeTaskScheduler } = await import('../lib/shopee/shopeeTasks');
  const { runShopeeEscrowSettlement, simularLiquidacaoShopee } =
    await import('../lib/shopee/pedidos/liquidacaoSweep');

  /* ------------------------------ the preamble ----------------------------- */

  aviso(
    live
      ? '[shopee/liquidar:pagamentos] modo: LIVE — VAI GRAVAR'
      : '[shopee/liquidar:pagamentos] modo: DRY-RUN — não grava nada',
  );
  const app = getAdminApp();
  aviso(`  projeto ......... ${app.options.projectId ?? '(não resolvido)'}`);
  aviso(`  database ........ ${process.env.FIREBASE_DATABASE_ID ?? 'default'}`);
  // ⚠️ The RAW value, and a blank one is spelled out rather than printed as an
  // empty string: `shopeeSandbox()` is `=== '1'`, so `''`, `true`, `yes` and `0`
  // are all PRODUCTION.
  const sandboxBruto = process.env.SHOPEE_SANDBOX;
  aviso(
    `  SHOPEE_SANDBOX .. ${sandboxBruto == null ? '(não definido)' : sandboxBruto.length === 0 ? '(vazio)' : sandboxBruto}`,
  );
  aviso(`  integracao ...... ${integracaoId}`);
  aviso(
    `  janela .......... ${janela === null ? '(a do próximo tick)' : `${carimboMs(janela.deMs)} → ${carimboMs(janela.ateMs)}`}`,
  );
  aviso(`  order_sn ........ ${orderSn ?? '(todas da janela)'}`);
  aviso(`  cursor .......... ${live && cursor ? 'SERÁ GRAVADO' : 'não será gravado'}`);

  const db = getAdminFirestore();

  // The same seam the sweep and `importar:pedido` use, and for its GUARDS: a
  // missing conta, a conta that is not Shopee, or a missing partner id/key fails
  // HERE rather than at Shopee.
  const ctx = await loadShopeeContext(db, integracaoId);
  const shopId = ctx.conta.shop_id;
  aviso(`  ambiente Shopee . ${ctx.config.sandbox ? 'SANDBOX' : 'PRODUÇÃO'}`);
  aviso(`  loja (shop_id) .. ${shopId == null ? '(nenhuma)' : String(shopId)}`);
  if (shopId == null) {
    aviso('');
    aviso(
      '❌ A conta está conectada por CONTA PRINCIPAL e não tem shop_id, então nenhuma ' +
        'chamada pode ser assinada. Reconecte escolhendo a loja.',
    );
    process.exitCode = 1;
    return;
  }
  aviso('');

  const nowMs = Date.now();

  /* --------------------------------- dry-run -------------------------------- */

  if (!live) {
    const simulacao = await simularLiquidacaoShopee(db, {
      integracaoId,
      client: ctx.createShopClient(),
      nowMs,
      ...(janela === null ? {} : { janela }),
      ...(orderSn === null ? {} : { orderSn }),
    });
    const resumos = simulacao.linhas.map((linha) => resumoDaLinhaSimulada(linha));

    if (json) {
      log(
        JSON.stringify(
          {
            modo: 'dry-run',
            integracaoId,
            janela: simulacao.janela,
            paginas: simulacao.paginas,
            ilegiveis: simulacao.ilegiveis,
            drenada: simulacao.drenada,
            linhas: resumos,
          },
          null,
          2,
        ),
      );
      return;
    }

    log('== DRY-RUN — nada foi gravado ==');
    log('');
    log(
      `  janela .................. ${simulacao.janela === null ? '(order_sn avulsa)' : `${carimboMs(simulacao.janela.deMs)} → ${carimboMs(simulacao.janela.ateMs)}`}`,
    );
    log(`  páginas lidas ........... ${String(simulacao.paginas)}`);
    log(`  linhas ilegíveis ........ ${String(simulacao.ilegiveis)}`);
    log(`  janela drenada? ......... ${simulacao.drenada ? 'sim' : 'NÃO (truncada)'}`);
    log('');
    log(`### linhas (${String(resumos.length)})`);
    if (resumos.length === 0) log('  (nenhuma)');
    for (let i = 0; i < resumos.length; i += 1) {
      for (const linha of renderResumoLiquidacao(resumos[i]!, simulacao.linhas[i]!.motivo)) {
        log(linha);
      }
    }
    log('');
    log('  (o corpo do escrow e o buyer_payment_info são omitidos de propósito)');
    return;
  }

  /* ---------------------------------- live ---------------------------------- */

  const resultado = await runShopeeEscrowSettlement(db, {
    nowMs,
    scheduler: createShopeeTaskScheduler(),
    apenasIntegracoes: [integracaoId],
    persistirCursor: cursor,
    ...(janela === null ? {} : { janela }),
  });

  if (json) {
    log(JSON.stringify({ modo: 'live', integracaoId, resultado }, null, 2));
    return;
  }

  log('== LIVE — a varredura de verdade ==');
  log('');
  for (const conta of resultado.contas) {
    log(`  integracao .............. ${conta.integracaoId}`);
    log(`    pulada ................ ${conta.pulada ?? '—'}`);
    log(
      `    janela ................ ${conta.janela === null ? '—' : `${carimboMs(conta.janela.deMs)} → ${carimboMs(conta.janela.ateMs)}`}`,
    );
    log(`    páginas / linhas ...... ${String(conta.paginas)} / ${String(conta.linhas)}`);
    log(
      `    liquidados ............ ${String(conta.liquidados)}   semMudanca=${String(conta.semMudanca)} obsoletos=${String(conta.obsoletos)}`,
    );
    log(
      `    pendentes ............. ${String(conta.pendentes)}   descartados=${String(conta.pendentesDescartados)} sintéticas=${String(conta.sinteticas)}`,
    );
    log(
      `    puladas / ilegíveis ... ${String(conta.puladas)} / ${String(conta.ilegiveis)}   duplicadas=${String(conta.duplicadas)}`,
    );
    log(
      `    drenada / truncada .... ${conta.drenada ? 'sim' : 'não'} / ${conta.truncada ? 'sim' : 'não'}   retomada=${conta.retomada ? 'sim' : 'não'}`,
    );
    log(`    erro .................. ${conta.error ?? '—'}`);
  }
  if (resultado.contas.length === 0) {
    log('  ⚠️ Nenhuma conta ATIVA com esse id — confira --integracao e o campo `ativo`.');
  }
}

await main().catch((err: unknown) => {
  // Narrow enough to be useful and never wide enough to print a payload — the
  // whole table is `descreverErroLiquidacao`, which is unit-tested.
  for (const linha of descreverErroLiquidacao(err)) aviso(linha);
  if (!(err instanceof ArgumentoInvalidoError)) {
    aviso('');
    aviso(
      'Nada garante que nada foi gravado: um erro DEPOIS de uma transação deixa a liquidação no lugar.',
    );
    aviso('Releia com --dry-run (ele não grava) antes de repetir com --live.');
  }
  process.exitCode = 1;
});
