/**
 * Rehearse the Shopee SHIPMENT-TRACKING path (#1515, step 7) from the command
 * line.
 *
 *   pnpm --filter @delfrance/shopee-app rastrear:pedido --integracao int-1 --order-sn 260910KJBHUJDM
 *
 * ## Why this exists
 *
 * The three shipment pushes (codes 4, 30 and 47) are LOSSY by design —
 * `timeout=3`, `push_guarantee=0`, three retries and then gone — and the sandbox
 * cannot emit codes 30 or 47 at all. So the first time this channel ever moves a
 * `freteInicial.estado` (a STOCK-MOVING field) would otherwise happen
 * unattended, from a push nobody can replay, against whatever
 * `get_package_detail` decided to answer. This script makes that first write a
 * deliberate, observable act against one named order, before the migration
 * window (root CLAUDE.md rule 8).
 *
 * ⚠️ **Dev-only, and never run by an agent.** In `--live` it updates a real
 * `pedidos/{id}` document and can enqueue a synthetic code-3 task.
 *
 * ## The two modes
 *
 * **`--dry-run` (the DEFAULT)** reads the pedido, resolves the package set,
 * calls Shopee and prints what a live delivery WOULD change. It writes nothing
 * and enqueues nothing, and that is structural rather than a promise: it calls
 * `simularRastreioShopee`, whose body contains no writer and no scheduler, and
 * whose verdict comes from the SAME `preverFreteShopee` the transaction runs.
 *
 * **`--live`** calls `rastrearPedidoShopee` once per resolved package — the real
 * arm body, the real class-B transaction, and the real synthetic code 3 when the
 * pedido does not exist yet — then re-reads the pedido and prints the stored
 * block.
 *
 * ⚠️ **Both modes reach Shopee** and spend the same rate-limited calls.
 *
 * ## What it prints, and what it must never print
 *
 * Every package goes through `lib/shopee/pedidos/rastrearPedidoCli.ts`, whose
 * summary is an ALLOW-LIST of fourteen fields. The `get_package_detail` body it
 * is built from also carries `recipient_address`, `driver_info`,
 * `virtual_contact_number` and a prescription block; none of them has a field to
 * travel in. A terminal transcript gets pasted into issues — the SVC-AN incident
 * (a log line that leaked a CNPJ into a public issue) is the local precedent.
 *
 * ## Exit codes
 *
 * `0` on ANY action, including `ignorado-sem-mudanca`, `ignorado-obsoleto` and
 * `ignorado-sem-pedido` — those are answers, not failures. `1` only on a throw,
 * described by CLASS plus Shopee's `code`/`path` and never a payload.
 */
import { millisToMicros } from '@delfrance/core/datetime';

import {
  ArgumentoInvalidoError,
  DIAGNOSTICO_DE_ENSAIO,
  USO_RASTREAR_PEDIDO,
  carimboMicros,
  descreverErroRastreio,
  parseArgsRastrearPedido,
  renderFreteArmazenado,
  renderResumoRastreio,
  resumoDoFreteArmazenado,
  resumoDoPacoteSimulado,
} from '../lib/shopee/pedidos/rastrearPedidoCli';

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

function listaOuVazio(valores: readonly string[]): string {
  return valores.length === 0 ? '(nenhum)' : valores.join(', ');
}

async function main(): Promise<void> {
  const comando = parseArgsRastrearPedido(process.argv.slice(2));
  if (comando.kind === 'ajuda') {
    log(USO_RASTREAR_PEDIDO);
    return;
  }
  const { integracaoId, orderSn, packageNumber, live, json, projectId } = comando.args;

  // ⚠️ The dynamic imports are what make "`--help` touches no environment and no
  // Firestore" STRUCTURAL instead of a claim: nothing below this line has been
  // loaded yet, so no module-level env read, admin singleton or client
  // construction can run on the help path. They also keep `--project` effective
  // — the admin app resolves its project id once, at first use.
  if (projectId != null) process.env.FIREBASE_PROJECT_ID = projectId;

  const { getAdminApp, getAdminFirestore } = await import('../lib/firebase/admin');
  const { loadShopeeContext } = await import('../lib/shopee/core/shopee');
  const { pedidoCollection } = await import('@delfrance/data/admin/collections');
  const { rastrearPedidoShopee } = await import('../lib/shopee/pedidos/rastrearPedido');
  const { resolverPacotesDeRastreio, simularRastreioShopee } =
    await import('../lib/shopee/pedidos/rastrearPedidoSimulacao');

  /* ------------------------------ the preamble ----------------------------- */

  aviso(
    live
      ? '[shopee/rastrear:pedido] modo: LIVE — VAI GRAVAR'
      : '[shopee/rastrear:pedido] modo: DRY-RUN — não grava nada',
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
  aviso(`  package ......... ${packageNumber ?? '(resolvido dos volumes e da order)'}`);

  const db = getAdminFirestore();

  // The same seam the frete arm and `importar:pedido` use, and for its GUARDS: a
  // missing conta, a conta that is not Shopee, or a missing partner id/key fails
  // HERE rather than at Shopee.
  const ctx = await loadShopeeContext(db, integracaoId);
  const shopId = ctx.conta.shop_id;
  aviso(`  ambiente Shopee . ${ctx.config.sandbox ? 'SANDBOX' : 'PRODUÇÃO'}`);
  aviso(`  loja (shop_id) .. ${shopId == null ? '(nenhuma)' : String(shopId)}`);
  if (shopId == null) {
    // Deliberately not a throw: it is a legitimate conta state (consent given by
    // the main account), and the operator's next step is a re-consent.
    aviso('');
    aviso(
      '❌ A conta está conectada por CONTA PRINCIPAL e não tem shop_id, então nenhuma ' +
        'chamada pode ser assinada. Reconecte escolhendo a loja.',
    );
    process.exitCode = 1;
    return;
  }
  aviso('');

  const client = ctx.createShopClient();
  // The run's ONE clock read, converted ONCE and handed DOWN — `importarPedido`'s
  // pattern (µs site 2), here in the I/O half so that neither tested lib module
  // holds a clock or a converter of its own: `rastrearPedidoSimulacao.ts` and
  // `rastrearPedidoCli.ts` only CALL µs site 3 (`microsDeSegundosShopee`) for the
  // order clock and for rendering, the way `pagamentoMapping.ts` does.
  // `rastrearPedidoShopee` takes the MILLISECONDS and performs its own
  // conversion (µs site 6); the simulation takes the µs.
  const nowMs = Date.now();
  const nowUs = millisToMicros(nowMs);

  /* --------------------------------- dry-run -------------------------------- */

  if (!live) {
    const simulacao = await simularRastreioShopee(db, client, {
      integracaoId,
      orderSn,
      packageNumber,
      nowUs,
    });
    const resumos = simulacao.linhas.map((linha) => resumoDoPacoteSimulado(linha));

    if (json) {
      log(
        JSON.stringify(
          {
            modo: 'dry-run',
            integracaoId,
            orderSn,
            pedidoId: simulacao.pedidoId,
            existePedido: simulacao.existePedido,
            temFreteInicial: simulacao.temFreteInicial,
            volumesArmazenados: simulacao.volumesArmazenados,
            pacotesDaOrdem: simulacao.pacotesDaOrdem,
            soNaShopee: simulacao.soNaShopee,
            soNoPedido: simulacao.soNoPedido,
            ilegiveis: simulacao.ilegiveis,
            truncadoNoLimite: simulacao.truncadoNoLimite,
            pacotes: resumos,
            backstop:
              simulacao.backstop === null
                ? null
                : {
                    relogioDoPedidoS: simulacao.backstop.relogioDoPedidoS,
                    ignorados: simulacao.backstop.ignorados,
                    acao: simulacao.backstop.previsao.acao,
                    estadoAlvo: simulacao.backstop.previsao.diagnosticos.estadoAlvo,
                    campos: simulacao.backstop.previsao.campos,
                    tokens: simulacao.backstop.observados.map((o) => ({
                      packageNumber: o.packageNumber,
                      fulfillmentStatus: o.fulfillmentStatus,
                    })),
                  },
          },
          null,
          2,
        ),
      );
      return;
    }

    log('== DRY-RUN — nada foi gravado ==');
    log('');
    log(`  pedidoId ................ ${simulacao.pedidoId}`);
    log(`  pedido existe? .......... ${simulacao.existePedido ? 'sim' : 'NÃO'}`);
    log(`  tem freteInicial? ....... ${simulacao.temFreteInicial ? 'sim' : 'NÃO'}`);
    if (!simulacao.existePedido) {
      log('');
      log('  ⚠️ Sem pedido, uma entrega real ADIARIA e enfileiraria um code 3 sintético.');
      log('     Este dry-run não enfileirou nada.');
    }
    log('');
    log('### conjunto de pacotes');
    log(`  volumes guardados ....... ${listaOuVazio(simulacao.volumesArmazenados)}`);
    log(
      `  pacotes da order ........ ${simulacao.pacotesDaOrdem === null ? '(não consultado — --package foi informado)' : listaOuVazio(simulacao.pacotesDaOrdem)}`,
    );
    // ⚠️ THE line of this report: a package Shopee knows and the stored volumes
    // do not is a split nothing in the web UI shows.
    log(`  só na Shopee ............ ${listaOuVazio(simulacao.soNaShopee)}`);
    log(`  só no pedido ............ ${listaOuVazio(simulacao.soNoPedido)}`);
    log(`  linhas ilegíveis ........ ${String(simulacao.ilegiveis)}`);
    if (simulacao.truncadoNoLimite) {
      log('  ⚠️ mais pacotes do que uma chamada em lote aceita — a lista foi truncada.');
    }
    log('');
    log(`### pacotes (${String(resumos.length)})`);
    if (resumos.length === 0) log('  (nenhum)');
    for (let i = 0; i < resumos.length; i += 1) {
      for (const linha of renderResumoRastreio(resumos[i]!, simulacao.linhas[i]!.motivo)) {
        log(linha);
      }
    }
    log('');
    log('### o que o BACKSTOP do code 3 dobraria da mesma order');
    if (simulacao.backstop === null) {
      log('  (não consultado — --package foi informado)');
    } else {
      const b = simulacao.backstop;
      log(
        `  relógio da order (s) .... ${b.relogioDoPedidoS == null ? '—' : String(b.relogioDoPedidoS)}`,
      );
      log(`  pacotes ilegíveis ....... ${String(b.ignorados)}`);
      log(`  ação .................... ${b.previsao.acao}`);
      log(`  estado alvo ............. ${b.previsao.diagnosticos.estadoAlvo ?? '—'}`);
      log(
        `  campos que mudariam ..... ${b.previsao.campos.length === 0 ? '(nenhum)' : b.previsao.campos.join(', ')}`,
      );
      for (const o of b.observados) {
        log(`    ${o.packageNumber} ......... ${o.fulfillmentStatus ?? '—'}`);
      }
      log('');
      log('  (compare o token acima com o do get_package_detail — item 28 do registro)');
    }
    log('');
    log('  (recipient_address, driver_info e o bloco de receita são omitidos de propósito)');
    return;
  }

  /* ---------------------------------- live ---------------------------------- */

  const resolucao = await resolverPacotesDeRastreio(db, client, {
    integracaoId,
    orderSn,
    packageNumber,
  });

  const resultados = [];
  for (const alvo of resolucao.alvos) {
    resultados.push(
      await rastrearPedidoShopee(db, {
        integracaoId,
        shopId,
        orderSn,
        packageNumber: alvo.packageNumber,
        // ⚠️ There is no push behind a rehearsal, and the diagnostic says so
        // field by field — see DIAGNOSTICO_DE_ENSAIO.
        code: DIAGNOSTICO_DE_ENSAIO.code,
        nowMs,
        diagnostico: DIAGNOSTICO_DE_ENSAIO,
      }),
    );
  }

  const snap = await pedidoCollection.docRef(db, {}, resolucao.pedidoId).get();
  const armazenado = resumoDoFreteArmazenado(
    snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>).freteInicial : null,
  );

  if (json) {
    log(
      JSON.stringify(
        {
          modo: 'live',
          integracaoId,
          orderSn,
          pedidoId: resolucao.pedidoId,
          alvos: resolucao.alvos,
          soNaShopee: resolucao.soNaShopee,
          soNoPedido: resolucao.soNoPedido,
          resultados,
          freteInicial: armazenado,
        },
        null,
        2,
      ),
    );
    return;
  }

  log('== LIVE — a transação de frete de verdade ==');
  log('');
  log(`  pedidoId ................ ${resolucao.pedidoId}`);
  log(`  pacotes rodados ......... ${String(resolucao.alvos.length)}`);
  log(`  só na Shopee ............ ${listaOuVazio(resolucao.soNaShopee)}`);
  log(`  só no pedido ............ ${listaOuVazio(resolucao.soNoPedido)}`);
  log('');
  for (const r of resultados) {
    log(`  package_number .......... ${r.packageNumber}`);
    log(`    ação .................. ${r.acao}`);
    log(`    estado escrito ........ ${r.estadoEscrito ?? '—'}`);
    log(`    status do marketplace . ${r.statusMarketplace ?? '—'}`);
    log(`    campos ................ ${r.campos.length === 0 ? '(nenhum)' : r.campos.join(', ')}`);
    log(`    code 3 sintético ...... ${r.sinteticaEnfileirada ? 'ENFILEIRADO' : 'não'}`);
    log(`    detalhe ............... ${r.detail}`);
  }
  if (resultados.length === 0) {
    log('  ⚠️ Nenhum pacote resolvido — nem --package, nem volumes, nem package_list.');
  }
  log('');
  log('### freteInicial depois da releitura');
  for (const linha of renderFreteArmazenado(armazenado)) log(linha);
  log('');
  log(
    `  (carimbos em µs: ultimaModificacao ${carimboMicros(armazenado?.ultimaModificacaoUs ?? null)})`,
  );
}

await main().catch((err: unknown) => {
  // Narrow enough to be useful and never wide enough to print a payload — the
  // whole table is `descreverErroRastreio`, which is unit-tested.
  for (const linha of descreverErroRastreio(err)) aviso(linha);
  if (!(err instanceof ArgumentoInvalidoError)) {
    aviso('');
    aviso(
      'Nada garante que nada foi gravado: um erro DEPOIS de uma transação deixa o frete no lugar.',
    );
    aviso('Releia com --dry-run (ele não grava) antes de repetir com --live.');
  }
  process.exitCode = 1;
});
