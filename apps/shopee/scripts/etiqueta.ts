/**
 * Download the shipping label of ONE Shopee pedido from the command line — the
 * step-15 rehearsal (#1523).
 *
 *   pnpm --filter @delfrance/shopee-app baixar:etiqueta --pedido <pedidoId>
 *
 * ## Why this exists
 *
 * The label otherwise comes from the pedido screen's Imprimir button → the
 * label route → `executarEtiquetaShopee`. This script drives THE SAME runner
 * from a terminal, so the channel's first `ship_order` is deliberate and
 * observable, and a dry run shows where a pedido stands (arranged? tracked?
 * the document ready?) without changing anything at Shopee.
 *
 * ⚠️ **Dev-only, and never run by an agent.** In `--live` it ARRANGES the
 * shipment of a REAL marketplace order — `ship_order` is irreversible.
 *
 * ## The two modes
 *
 * **The dry run (the DEFAULT)** runs the runner with `somenteLeitura: true`:
 * every read, and never `ship_order`, `create_shipping_document` or
 * `download_shipping_document`.
 *
 * **`--live`** runs the flow for real with a 5-minute budget. It never writes
 * the file: it prints the sniffed format and the byte length.
 *
 * ## What it prints, and what it must never print
 *
 * Everything goes through `lib/shopee/etiqueta/etiquetaCli.ts`, whose output
 * is an ALLOW-LIST built by name: counts, phases by package POSITION, action
 * and motivo slugs with their sentence, the document type token, the format
 * and the byte length — never the order number, a package number, a tracking
 * number, an address, a byte or the pedido id. Its error describer prints a
 * Shopee error by CLASS and code, never by its message.
 *
 * ⚠️ Every library line (the runner's one `console.warn` included) goes to
 * STDERR; the report alone reaches stdout.
 *
 * ## Exit codes
 *
 * `0` on ANY report — a refusal, a question, a wait and a dry run included:
 * each is an ANSWER. `1` only on a bad command line or a throw, described by
 * CLASS.
 */
import {
  descreverErroEtiqueta,
  ehRecusaAntesDoEnvioEtiqueta,
  parseArgsEtiqueta,
  renderizarRelatorioEtiqueta,
  rodarEtiquetaCli,
  USO_BAIXAR_ETIQUETA,
} from '../lib/shopee/etiqueta/etiquetaCli';

/** stdout — the report, and nothing else (see the module docblock). */
function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** stderr — the preamble, the warnings and every library line. */
function aviso(message: string): void {
  console.error(message);
}

/** A raw env value, spelled out when unset or blank rather than printed as nothing. */
function bruto(valor: string | undefined, vazio: string): string {
  if (valor == null) return '(não definido)';
  return valor.length === 0 ? vazio : valor;
}

/** Whether the failure path must warn that a shipment may already be arranged. */
let modoLive = false;

async function main(): Promise<void> {
  const comando = parseArgsEtiqueta(process.argv.slice(2));
  if (comando.kind === 'ajuda') {
    log(USO_BAIXAR_ETIQUETA);
    return;
  }
  const { live, formato, projectId } = comando.args;
  modoLive = live;

  // Every library line to STDERR.
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
      ? '[shopee/baixar:etiqueta] modo: LIVE — VAI ORGANIZAR O ENVIO DE VERDADE NA SHOPEE (irreversível)'
      : '[shopee/baixar:etiqueta] modo: DRY-RUN — só leituras; nada é organizado, gerado nem baixado',
  );
  // `getAdminApp()` resolves credentials and the project id locally; it opens no
  // connection.
  const app = getAdminApp();
  aviso(`  projeto ......... ${app.options.projectId ?? '(não resolvido)'}`);
  aviso(`  database ........ ${process.env.FIREBASE_DATABASE_ID ?? 'default'}`);
  // ⚠️ The RAW value: only exactly `1` is the sandbox; `''`, `true` and `0` are
  // PRODUCTION.
  aviso(`  SHOPEE_SANDBOX .. ${bruto(process.env.SHOPEE_SANDBOX, '(vazio — PRODUÇÃO)')}`);
  aviso(`  formato ......... ${formato}`);
  aviso('');

  const db = getAdminFirestore();
  const { loadShopeeContext } = await import('../lib/shopee/core/shopee');
  // ⚠️ The runner reaches `next/server` through `respostaEtiqueta.ts` (its pt-BR
  // sentences); it loads under plain Node.
  const { executarEtiquetaShopee } = await import('../lib/shopee/etiqueta/executarEtiqueta');

  const relatorio = await rodarEtiquetaCli(
    {
      db,
      // The script's clock and sleep, handed DOWN; the lib module reads none.
      agora: () => Date.now(),
      dormir: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      criarCliente: async (contaId: string) =>
        (await loadShopeeContext(db, contaId)).createShopClient(),
      executar: executarEtiquetaShopee,
    },
    comando.args,
  );
  for (const linha of renderizarRelatorioEtiqueta(relatorio)) log(linha);
}

await main().catch((err: unknown) => {
  // By CLASS, never by a Shopee message — the whole table is unit-tested.
  for (const linha of descreverErroEtiqueta(err)) aviso(linha);
  if (modoLive && !ehRecusaAntesDoEnvioEtiqueta(err)) {
    aviso('');
    aviso(
      'Nada garante que o envio não foi organizado: uma falha DEPOIS do ship_order deixa o pacote organizado na Shopee.',
    );
    aviso('Releia sem --live (o dry-run não organiza nada) antes de repetir com --live.');
  }
  process.exitCode = 1;
});
