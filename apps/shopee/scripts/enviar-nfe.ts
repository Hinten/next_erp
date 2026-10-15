/**
 * Upload the approved NF-e of hand-picked Shopee pedidos from the command line —
 * the step-14 re-drive and rehearsal (#1522).
 *
 *   pnpm --filter @delfrance/shopee-app enviar:nfe --pedido <pedidoId>
 *
 * ## Why this exists
 *
 * The upload otherwise runs unattended: an NF-e approval → the trigger → the
 * NF-e queue → `processarNfeShopee`. This script drives THE SAME handler from a
 * terminal against named pedidos, so the channel's first `upload_invoice_doc` is
 * deliberate and observable — and it is the recovery for a pedido whose trigger
 * never fired (the queue valve was shut, or the NF-e arrived with the migrated
 * corpus and fired nothing).
 *
 * ⚠️ **Dev-only, and never run by an agent.** In `--live` it uploads a REAL
 * fiscal document to a REAL marketplace order, and the handler may raise or
 * resolve the pedido's aviso and mark its frete with an error.
 *
 * ## The two modes
 *
 * **`--dry-run` (the DEFAULT)** runs `simularEnvioNfeShopee` per pedido — the
 * handler's own prefix and ONE `get_order_detail` — and prints what the upload
 * would do. It uploads, writes and enqueues nothing: the dry run is handed no
 * scheduler, no increment sentinel and no upload entry point.
 *
 * **`--live`** runs `processarNfeShopee` IN THIS PROCESS as the queue's first
 * attempt, with a RECORDING scheduler: a recheck, a SERPRO wait or a pause the
 * queue would have scheduled is PRINTED, never enqueued, and the operator runs
 * the command again later. A fresh approval (inside the SERPRO window) is
 * refused per pedido with `aguardando-serpro`.
 *
 * ## What it prints, and what it must never print
 *
 * Everything goes through `lib/shopee/nfe/enviarNfeCli.ts`, whose output is an
 * ALLOW-LIST built by name: pedido ids, the NF-e slot, outcome and motivo slugs
 * with their sentence, byte counts and `chave: confere | difere | ausente` —
 * never the key, a CNPJ, the XML, the upload filename, the order number, a token
 * or Shopee's raw text. Its error describer prints a Shopee error by CLASS and
 * code, never by its message (which carries Shopee's own sentence).
 *
 * ⚠️ The handler writes its own completion line through `console.info`, which
 * Node sends to STDOUT; under `--json` that would put a line before the
 * document. So every library line is sent to STDERR here, and the report alone
 * reaches stdout. The completion line itself carries ids, slugs and a token code
 * only (the handler's own rule).
 *
 * ## Exit codes
 *
 * `0` on ANY report — including one where every pedido was refused, a dry run
 * that would send nothing, and a SERPRO refusal: each of those is an ANSWER. `1`
 * only on a bad command line or a throw (a transient Shopee failure at attempt 0
 * throws, exactly as it would reach the queue's retry), described by CLASS.
 */
import {
  descreverErroEnviarNfe,
  ehRecusaAntesDoEnvioNfe,
  ensaiarEnvioNfe,
  enviarNfeAoVivo,
  lerArgumentosEnviarNfe,
  renderizarJsonEnviarNfe,
  renderizarLinhaEnviarNfe,
  renderizarRelatorioEnviarNfe,
  USO_ENVIAR_NFE,
  type LinhaEnviarNfe,
  type RelatorioEnviarNfe,
} from '../lib/shopee/nfe/enviarNfeCli';

/** stdout — the report, and nothing else (see the module docblock). */
function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * stderr — the preamble, the warnings and every library line. Under `--json`
 * the stdout must stay a single parseable document.
 */
function aviso(message: string): void {
  console.error(message);
}

/** A raw env value, spelled out when unset or blank rather than printed as nothing. */
function bruto(valor: string | undefined, vazio: string): string {
  if (valor == null) return '(não definido)';
  return valor.length === 0 ? vazio : valor;
}

/** Whether the failure path must warn that something may already have been written. */
let modoLive = false;
/** The pedidos concluded before a failure — printed on the failure path. */
const concluidas: LinhaEnviarNfe[] = [];

async function main(): Promise<void> {
  const comando = lerArgumentosEnviarNfe(process.argv.slice(2));
  if (comando.kind === 'ajuda') {
    log(USO_ENVIAR_NFE);
    return;
  }
  const { pedidoIds, nfeId, live, json, projectId } = comando.args;
  modoLive = live;

  // Every library line to STDERR — the handler's completion line included.
  // eslint-disable-next-line no-console -- rerouting, not printing
  console.info = console.error;
  // eslint-disable-next-line no-console -- rerouting, not printing
  console.log = console.error;

  // ⚠️ The dynamic imports are what make "`--help` touches no environment and no
  // Firestore" STRUCTURAL, and they keep `--project` effective — the admin app
  // resolves its project id once, at first use.
  if (projectId != null) process.env.FIREBASE_PROJECT_ID = projectId;

  const { getAdminApp, getAdminFirestore } = await import('../lib/firebase/admin');

  /* ------------------------------ the preamble ----------------------------- */

  aviso(
    live
      ? '[shopee/enviar:nfe] modo: LIVE — VAI ENVIAR NF-e DE VERDADE À SHOPEE (nada é enfileirado)'
      : '[shopee/enviar:nfe] modo: DRY-RUN — não envia, não grava e não enfileira nada',
  );
  // `getAdminApp()` resolves credentials and the project id locally; it opens no
  // connection.
  const app = getAdminApp();
  aviso(`  projeto ......... ${app.options.projectId ?? '(não resolvido)'}`);
  aviso(`  database ........ ${process.env.FIREBASE_DATABASE_ID ?? 'default'}`);
  // ⚠️ The RAW value: only exactly `1` is the sandbox; `''`, `true` and `0` are
  // PRODUCTION.
  aviso(`  SHOPEE_SANDBOX .. ${bruto(process.env.SHOPEE_SANDBOX, '(vazio — PRODUÇÃO)')}`);
  aviso(`  pedidos ......... ${String(pedidoIds.length)}: ${pedidoIds.join(', ')}`);
  aviso(`  nfe ............. ${nfeId ?? 'regra de escolha, por pedido'}`);
  aviso('');

  const db = getAdminFirestore();
  const comuns = {
    db,
    // ONE clock read per pedido, handed DOWN; the lib module reads none.
    agora: () => Date.now(),
    esperar: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    aoConcluir: (linha: LinhaEnviarNfe) => {
      concluidas.push(linha);
    },
  };

  let relatorio: RelatorioEnviarNfe;
  if (!live) {
    const { simularEnvioNfeShopee } = await import('../lib/shopee/nfe/processarNfe');
    relatorio = await ensaiarEnvioNfe(
      { pedidoIds, nfeId },
      { ...comuns, simular: simularEnvioNfeShopee },
    );
  } else {
    // firebase-admin — the aviso counter is a tier-0 FieldValue.
    const { FieldValue } = await import('firebase-admin/firestore');
    const { processarNfeShopee } = await import('../lib/shopee/nfe/processarNfe');
    relatorio = await enviarNfeAoVivo(
      { pedidoIds, nfeId },
      {
        ...comuns,
        processar: processarNfeShopee,
        increment: (by: number) => FieldValue.increment(by),
      },
    );
  }

  if (json) {
    log(renderizarJsonEnviarNfe(relatorio));
    return;
  }
  for (const linha of renderizarRelatorioEnviarNfe(relatorio)) log(linha);
}

await main().catch((err: unknown) => {
  if (concluidas.length > 0) {
    aviso(`${String(concluidas.length)} pedido(s) concluído(s) ANTES da falha:`);
    concluidas.forEach((linha, i) => {
      for (const l of renderizarLinhaEnviarNfe(linha, i, concluidas.length, modoLive)) aviso(l);
    });
    aviso('');
  }
  // By CLASS, never by a Shopee message — the whole table is unit-tested.
  for (const linha of descreverErroEnviarNfe(err)) aviso(linha);
  if (modoLive && !ehRecusaAntesDoEnvioNfe(err)) {
    aviso('');
    aviso(
      'Nada garante que nada foi enviado: uma falha DEPOIS do upload deixa a NF-e anexada na Shopee.',
    );
    aviso('Releia com --dry-run (ele não envia nada) antes de repetir com --live.');
  }
  process.exitCode = 1;
});
