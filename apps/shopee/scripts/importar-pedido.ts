/**
 * Import ONE Shopee order into the ERP from the command line — the step-5
 * rehearsal.
 *
 *   pnpm --filter @delfrance/shopee-app importar:pedido \
 *     --integracao int-1 --order-sn 220810QSK8S7BX
 *
 * ## Why this exists
 *
 * `importarPedidoShopee` reaches production only through a Cloud Tasks handler
 * fed by a push nobody can trigger on demand. So the first ERP write this
 * channel ever performs would otherwise happen unattended, on a queue, against
 * whatever order Shopee decided to send. This script makes that first write a
 * deliberate, observable act against the sandbox — one named order, one human,
 * one terminal — before the migration window (root CLAUDE.md rule 8).
 *
 * ⚠️ **Dev-only, and never run by an agent.** In `--live` it writes real
 * documents: a `pedidos`, possibly a `clientes` + its `enderecos`, and one
 * `incidentes` per unbound line.
 *
 * ## The two modes
 *
 * **`--dry-run` (the DEFAULT)** calls Shopee (`get_order_detail` +
 * `get_escrow_detail`), resolves the produto of every line, looks up the
 * conta's active `int_frete` doc, runs the mappers and prints what a write
 * WOULD store. It writes nothing, and that is structural rather than a promise:
 * it calls `prepararImportacaoPedidoShopee`, whose body contains no writer at all
 * (see its docblock). The `int_frete` ref it prints is read off the mapped block
 * that call returned — there is no second lookup here.
 *
 * **`--live`** calls `importarPedidoShopee` exactly as the code-3 task handler
 * does — same arguments, same default client seam, same clock shape — and then
 * reads the pedido back.
 *
 * ⚠️ **Both modes reach Shopee.** A dry-run is not offline; it spends the same
 * two API calls and, in the sandbox, is subject to the same rate limits.
 *
 * ## The TEST buyer mode (`--importar-cliente`)
 *
 * The SG sandbox order captures no buyer (region not BR, name masked, a 6-digit
 * postal code), so this mode lets a human see the buyer and the address land:
 * the buyer adapter reads a simulated row (Shopee's CPF when usable, else
 * `--cpf-teste`, else the repo's fake one; `--nome-teste` / `--cep-teste`
 * replace only those two fields) while the REAL row drives everything else.
 * `--cpf-teste`'s digits are printed nowhere by this script — the reports name
 * the SOURCE of the document, and the preamble only whether one was given. ⚠️
 * pnpm itself echoes the command line (its `$ …` banner, and the
 * `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` block on exit 1), so the runbook runs
 * `--cpf-teste` under `pnpm -s`, which keeps this script's own output and exit
 * code and drops pnpm's. Refused (exit 1,
 * before any buyer or pedido write) without the sandbox override, on a BR
 * order, and in `--live` without an explicit `--project` matching the admin app
 * under a service account issued for it. The dry run adds the real-vs-simulated
 * verdicts and the endereço preview to stdout, and the VALUES Shopee sent to
 * STDERR only; `--live` adds the project, collision, stored-link and
 * terminal-capture refusals (`lib/shopee/pedidos/importarCompradorTeste.ts`).
 *
 * ## What it prints, and what it must never print
 *
 * The pedido is rendered through `lib/shopee/pedidos/importarPedidoCli.ts`,
 * whose summary is an ALLOW-LIST: the buyer's name, document, phone, address and
 * e-mail have no field to travel in, `observacoesInternas` is reduced to a
 * character count, and the cliente/endereço appear as outer-refs — ids — only.
 * The capture VERDICT is printed (`capturado` / `pendente` / `expirado` plus the
 * refused field NAMES), never the fields it inspected. A terminal transcript
 * gets pasted into issues; the SVC-AN incident (a `xMotivo` log that leaked a
 * CNPJ into a public log) is the local precedent.
 *
 * ⚠️ It holds no Shopee id, key, token or shop id — the usage text names
 * `int-1` and a documentation `order_sn`, and the shop id comes from the
 * integração document at runtime.
 *
 * ## Exit codes
 *
 * `0` on ANY import outcome, including `ignorado-inexistente` and
 * `ignorado-obsoleto` — those are answers, not failures. `1` only on a throw,
 * described by CLASS plus Shopee's `code`/`message` and never a payload.
 */
import {
  ArgumentoInvalidoError,
  SimulacaoCompradorRecusadaError,
  USO_IMPORTAR_PEDIDO,
  descreverErro,
  exigirSandboxParaSimulacao,
  linhaDoCompradorNoPreambulo,
  parseArgsImportarPedido,
  projetoDaCredencial,
  renderCompradorGravado,
  renderCompradorSimulado,
  renderResumoPedido,
  resumoDoCompradorGravado,
  resumoDoCompradorSimulado,
  resumoDoPedidoArmazenado,
  resumoDoPedidoMapeado,
  resumoDosPagamentosArmazenados,
  resumoDosPagamentosMapeados,
  valoresEnviadosPelaShopee,
} from '../lib/shopee/pedidos/importarPedidoCli';

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
 * BEFORE anything happens. So the preamble always goes to stderr and the JSON
 * always goes to stdout, whichever mode is active.
 */
function aviso(message: string): void {
  console.error(message);
}

async function main(): Promise<void> {
  const comando = parseArgsImportarPedido(process.argv.slice(2));
  if (comando.kind === 'ajuda') {
    log(USO_IMPORTAR_PEDIDO);
    return;
  }
  const { integracaoId, orderSn, live, json, projectId } = comando.args;
  // The TEST buyer mode, or `null`. Named once, and passed as the importer's
  // `simulacaoComprador` only below.
  const comprador = comando.args.comprador ?? null;

  // ⚠️ The dynamic imports are what make "`--help` touches no environment and no
  // Firestore" STRUCTURAL instead of a claim: nothing below this line has been
  // loaded yet, so no module-level env read, admin singleton or client
  // construction can run on the help path. They also keep `--project` effective
  // — the admin app resolves its project id once, at first use.
  if (projectId != null) process.env.FIREBASE_PROJECT_ID = projectId;

  const { getAdminApp, getAdminFirestore } = await import('../lib/firebase/admin');
  const { loadShopeeContext } = await import('../lib/shopee/core/shopee');
  const { makePedidoIdShopee } = await import('../lib/shopee/pedidos/orderIds');
  const { importarPedidoShopee, mapearPreparoPedidoShopee, prepararImportacaoPedidoShopee } =
    await import('../lib/shopee/pedidos/importarPedido');
  const { mapearPagamentosShopee } = await import('../lib/shopee/pedidos/pagamentoMapping');
  const { pagamentoCollection, pedidoCollection } =
    await import('@delfrance/data/admin/collections');

  /* ------------------------------ the preamble ----------------------------- */

  aviso(
    live
      ? '[shopee/importar:pedido] modo: LIVE — VAI GRAVAR'
      : '[shopee/importar:pedido] modo: DRY-RUN — não grava nada',
  );
  // `getAdminApp()` resolves credentials and the project id locally; it opens no
  // connection. Printing before that would have to guess at the fallback ladder.
  const app = getAdminApp();
  aviso(`  projeto ......... ${app.options.projectId ?? '(não resolvido)'}`);
  aviso(`  database ........ ${process.env.FIREBASE_DATABASE_ID ?? 'default'}`);
  // ⚠️ The RAW value, and a blank one is spelled out rather than printed as an
  // empty string: `shopeeSandbox()` is `=== '1'`, so `''`, `true`, `yes` and `0`
  // are all PRODUCTION. The resolved verdict is the `ambiente Shopee` line below.
  const sandboxBruto = process.env.SHOPEE_SANDBOX;
  aviso(
    `  SHOPEE_SANDBOX .. ${sandboxBruto == null ? '(não definido)' : sandboxBruto.length === 0 ? '(vazio)' : sandboxBruto}`,
  );
  aviso(`  integracao ...... ${integracaoId}`);
  aviso(`  order_sn ........ ${orderSn}`);
  // Whether each substitute was GIVEN — never a value. Built by the tested lib
  // half, so this file never touches `--cpf-teste`'s digits.
  if (comprador !== null) aviso(linhaDoCompradorNoPreambulo(comprador));

  const db = getAdminFirestore();

  // The same seam the code-3 arm and `oauth:url` use, and for its GUARDS: a
  // missing conta, a conta that is not Shopee, or a missing partner id/key fails
  // HERE rather than at Shopee.
  const ctx = await loadShopeeContext(db, integracaoId);
  const shopId = ctx.conta.shop_id;
  aviso(`  ambiente Shopee . ${ctx.config.sandbox ? 'SANDBOX' : 'PRODUÇÃO'}`);
  aviso(`  loja (shop_id) .. ${shopId == null ? '(nenhuma)' : String(shopId)}`);
  // The TEST buyer mode runs only on the sandbox — refused BEFORE any Shopee
  // call. The importer re-checks this from its own environment.
  let overrideSandboxAtivo = false;
  if (comprador !== null) {
    const { overrideDeSandboxAtivo } = await import('../lib/shopee/precos/regiaoPreco');
    overrideSandboxAtivo = overrideDeSandboxAtivo(ctx.config);
    exigirSandboxParaSimulacao(overrideSandboxAtivo);
  }
  if (shopId == null) {
    // Deliberately not a throw: it is a legitimate conta state (consent given by
    // main account), and the operator's next step is a re-consent, not a stack.
    aviso('');
    aviso(
      '❌ A conta está conectada por CONTA PRINCIPAL e não tem shop_id, então nenhuma ' +
        'chamada pode ser assinada. Reconecte escolhendo a loja.',
    );
    process.exitCode = 1;
    return;
  }
  aviso('');

  const pedidoId = makePedidoIdShopee(integracaoId, orderSn);
  const nowMs = Date.now();

  /* --------------------------------- dry-run -------------------------------- */

  if (!live) {
    const preparado = await prepararImportacaoPedidoShopee(
      db,
      { integracaoId, shopId, orderSn, nowMs },
      comprador === null ? {} : { simulacaoComprador: comprador },
    );
    if (preparado.kind === 'inexistente') {
      relatarInexistente(preparado.resultado.detail, json, pedidoId, orderSn);
      return;
    }
    const preparo = preparado.preparo;
    // What Shopee SENT, verbatim — stderr only, and empty unless buyer mode on
    // the sandbox over a non-BR order (the function decides, not this call).
    for (const linha of valoresEnviadosPelaShopee({ overrideSandboxAtivo, preparo })) {
      aviso(linha);
    }
    const compradorSimulado =
      preparo.simulacao === null
        ? null
        : resumoDoCompradorSimulado(preparo.simulacao, preparo.captura, preparo.armazenado);
    // The buyer is NOT resolved: `findOrCreateCliente` is a write. See
    // `mapearPreparoPedidoShopee`.
    const mapeado = mapearPreparoPedidoShopee(preparo, {
      clienteOuterRef: null,
      enderecoOuterRef: null,
      camposRecusadosExtra: [],
    });
    const resumo = resumoDoPedidoMapeado(preparo.pedidoId, mapeado);
    // Step 6: the SAME pure mapper the importer runs, on the SAME inputs — the
    // dry-run has no second copy of it to drift from.
    const mapeadosPag = mapearPagamentosShopee({
      linha: preparo.linha,
      escrow: preparo.escrow,
      valorDoComprador: preparo.mapeados.dinheiro.pagamento.valorDoComprador,
      cupomShopee: preparo.mapeados.dinheiro.pagamento.cupomShopee,
      dinheiroProvisorio: preparo.mapeados.dinheiro.provisorio,
      watermarkUs: preparo.watermarkUs,
      nowUs: preparo.nowUs,
      contaId: integracaoId,
      orderSn,
    });
    const pagamentos = resumoDosPagamentosMapeados(mapeadosPag);

    if (json) {
      log(
        JSON.stringify(
          {
            modo: 'dry-run',
            integracaoId,
            orderSn,
            shopId,
            escrow: preparo.escrow !== null,
            jaExiste: preparo.armazenado !== null,
            conferencia: preparo.mapeados.conferencia,
            itensSemProduto: preparo.mapeados.itens.filter((i) => i.produtoUid == null).length,
            resumo,
            pagamentos,
            diagnosticosPagamento: mapeadosPag.diagnosticos,
            ...(compradorSimulado === null ? {} : { comprador: compradorSimulado }),
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
      `  escrow .................. ${preparo.escrow !== null ? 'lido' : 'AUSENTE (preços vêm do detalhe)'}`,
    );
    log(
      `  pedido já existe? ....... ${preparo.armazenado === null ? 'não (seria um `criado`)' : 'SIM'}`,
    );
    if (preparo.armazenado !== null) {
      const antes = resumoDoPedidoArmazenado(preparo.pedidoId, preparo.armazenado);
      log(`    estado armazenado ..... ${antes.estadoArmazenado ?? '—'}`);
      log(`    lastMarketplaceUpdate . ${antes.lastMarketplaceUpdateUs ?? '—'}`);
      log(`    watermark desta leitura ${preparo.watermarkUs}`);
      // ⚠️ Only a CREATE writes the conta's int_frete ref: an update KEEPS this
      // one, whatever the `int_frete da conta` line below says was found.
      log(
        `    int_frete armazenado .. ${antes.frete?.integracaoFreteOuterRef ?? '—'}   (uma atualização o mantém)`,
      );
      log(`    entrega armazenada .... ${antes.frete?.enderecoFreteOuterReference ?? '—'}`);
    }
    log(
      `  linhas sem produto ...... ${preparo.mapeados.itens.filter((i) => i.produtoUid == null).length} de ${preparo.mapeados.itens.length}`,
    );
    log('');
    logConferencia(preparo.mapeados.conferencia);
    log('');
    for (const linha of renderResumoPedido(resumo, pagamentos)) log(linha);
    if (compradorSimulado !== null) {
      log('');
      for (const linha of renderCompradorSimulado(compradorSimulado)) log(linha);
    }
    return;
  }

  /* ---------------------------------- live ---------------------------------- */

  const antes = await pedidoCollection.docRef(db, {}, pedidoId).get();
  const armazenadoAntes = antes.exists ? ((antes.data() ?? {}) as Record<string, unknown>) : null;
  const resumoAntes =
    armazenadoAntes === null ? null : resumoDoPedidoArmazenado(pedidoId, armazenadoAntes);

  if (!json) {
    log('== LIVE — o importador de verdade ==');
    log('');
    log(`  pedido antes ............ ${resumoAntes === null ? 'não existe' : 'JÁ EXISTE'}`);
    if (resumoAntes !== null) {
      log(`    estado ................ ${resumoAntes.estadoArmazenado ?? '—'}`);
      log(`    lastMarketplaceUpdate . ${resumoAntes.lastMarketplaceUpdateUs ?? '—'}`);
      log(`    int_frete ............. ${resumoAntes.frete?.integracaoFreteOuterRef ?? '—'}`);
      log(`    entrega ............... ${resumoAntes.frete?.enderecoFreteOuterReference ?? '—'}`);
    }
    log('');
  }

  const alvo = { integracaoId, shopId, orderSn, nowMs };
  // Buyer mode: the project, collision, stored-link and terminal-capture
  // refusals run first, then the importer's write half over the SAME preparo.
  // Otherwise the call the code-3 arm makes.
  let resultado;
  if (comprador === null) {
    resultado = await importarPedidoShopee(db, alvo);
  } else {
    const { importarPedidoComCompradorDeTeste } =
      await import('../lib/shopee/pedidos/importarCompradorTeste');
    // A cliente under a fake document is a write that must name its project.
    const projeto = {
      projetoPedido: projectId,
      projetoResolvido: app.options.projectId ?? null,
      projetoDaCredencial: projetoDaCredencial(app.options.credential),
    };
    resultado = (await importarPedidoComCompradorDeTeste(db, alvo, comprador, projeto)).resultado;
  }

  const pedidoIdFinal = resultado.pedidoId ?? pedidoId;
  const depois = await pedidoCollection.docRef(db, {}, pedidoIdFinal).get();
  const armazenadoDepois = depois.exists
    ? ((depois.data() ?? {}) as Record<string, unknown>)
    : null;
  const resumoDepois =
    armazenadoDepois === null ? null : resumoDoPedidoArmazenado(pedidoIdFinal, armazenadoDepois);
  const compradorGravado =
    comprador === null ? null : resumoDoCompradorGravado(resultado, armazenadoDepois);

  // Step 6 — the pagamentos as Firestore holds them AFTER the import. Read back
  // rather than reported from the transaction's own result: what an operator
  // needs to see is the document set, siblings and all.
  const pagsSnap = await pagamentoCollection.ref(db, { pedidoId: pedidoIdFinal }).get();
  const pagamentosDepois = resumoDosPagamentosArmazenados(
    pagsSnap.docs.map((d) => ({ id: d.id, data: (d.data() ?? {}) as Record<string, unknown> })),
  );

  if (json) {
    log(
      JSON.stringify(
        {
          modo: 'live',
          integracaoId,
          orderSn,
          shopId,
          acao: resultado.acao,
          detail: resultado.detail,
          orderStatus: resultado.orderStatus,
          itensSemProduto: resultado.itensSemProduto,
          acaoPagamentos: resultado.acaoPagamentos,
          pagamentosGravados: resultado.pagamentosGravados,
          antes: resumoAntes,
          resumo: resumoDepois,
          pagamentos: pagamentosDepois,
          ...(compradorGravado === null ? {} : { comprador: compradorGravado }),
        },
        null,
        2,
      ),
    );
    return;
  }

  log(`  resultado ............... ${resultado.acao}   (${resultado.detail})`);
  log(`  order_status ............ ${resultado.orderStatus ?? '—'}`);
  log(`  linhas sem produto ...... ${resultado.itensSemProduto}`);
  log(
    `  pagamentos .............. ${resultado.acaoPagamentos ?? '(não rodou)'}   gravados=${String(resultado.pagamentosGravados)}`,
  );
  log('');
  if (resumoDepois === null) {
    log(
      resultado.acao === 'ignorado-inexistente'
        ? '  A Shopee não conhece esta order — nada foi gravado.'
        : '  ⚠️ O pedido não foi encontrado na releitura. Confira o projeto e o database acima.',
    );
    return;
  }
  for (const linha of renderResumoPedido(resumoDepois, pagamentosDepois)) log(linha);
  if (compradorGravado !== null) {
    log('');
    for (const linha of renderCompradorGravado(compradorGravado)) log(linha);
  }
}

/** `ignorado-inexistente` in either mode — an ANSWER, so the exit code stays 0. */
function relatarInexistente(
  detail: string,
  json: boolean,
  pedidoId: string,
  orderSn: string,
): void {
  if (json) {
    log(
      JSON.stringify({ modo: 'dry-run', orderSn, acao: 'ignorado-inexistente', detail }, null, 2),
    );
    return;
  }
  log(`== DRY-RUN — a Shopee não conhece a order ${orderSn} ==`);
  log(`  motivo .................. ${detail}`);
  log(`  pedidoId que seria usado  ${pedidoId}`);
}

/** The item/total reconciliation — the first thing to read on a money surprise. */
function logConferencia(c: {
  somaDosItens: number;
  descontoDasLinhas: number;
  descontoTotal: number;
  freteCobrado: number | null;
  totalConferido: number | null;
  totalDoPedido: number | null;
  diferenca: number | null;
  residual: number | null;
  fechamento: string;
  pisoAplicado: boolean;
  cupomShopee: number;
}): void {
  log('  conferência (Σ itens − desconto + frete  vs  o total pago, buyer_total_amount)');
  log(`    Σ itens ............... ${c.somaDosItens}   (líquido do desconto de cada linha)`);
  log(
    `    Σ desconto das linhas . ${c.descontoDasLinhas}   (diagnóstico — já está dentro de Σ itens)`,
  );
  log(
    `    descontoTotal ......... ${c.descontoTotal}   (o desconto da ordem que nenhuma linha traz)`,
  );
  log(`    frete cobrado ......... ${c.freteCobrado ?? '—'}`);
  log(`    total conferido ....... ${c.totalConferido ?? '—'}`);
  log(
    `    total da order ........ ${c.totalDoPedido ?? '—'}   (buyer_total_amount quando o escrow responde)`,
  );
  log(`    diferença ............. ${c.diferenca ?? '— (a order ainda não foi paga)'}`);
  log(`    resíduo / fechamento .. ${c.residual ?? '—'} / ${c.fechamento}`);
  log(
    `    piso da NF-e .......... ${c.pisoAplicado ? `APLICADO — cupom ${c.cupomShopee}` : 'não aplicado'}`,
  );
}

await main().catch((err: unknown) => {
  // Narrow enough to be useful and never wide enough to print a payload — the
  // whole table is `descreverErro`, which is unit-tested.
  for (const linha of descreverErro(err)) aviso(linha);
  // Both classes fire before any write — the footer would be a false alarm.
  if (
    !(err instanceof ArgumentoInvalidoError) &&
    !(err instanceof SimulacaoCompradorRecusadaError)
  ) {
    aviso('');
    aviso(
      'Nada garante que nada foi gravado: um erro DEPOIS da transação deixa o pedido no lugar.',
    );
    aviso('Releia com --dry-run (ele não grava) antes de repetir com --live.');
  }
  process.exitCode = 1;
});
