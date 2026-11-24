/**
 * Replay REAL captured Shopee order bodies through the real step-5 importer —
 * offline, over an in-memory Firestore — to see what a Brazilian order's buyer
 * capture (CPF, name, endereço) and everything else the import writes really
 * come out as.
 *
 *   pnpm --filter @delfrance/shopee-app reproduzir:pedido \
 *     --detalhe <arquivo> --escrow <arquivo>
 *
 * ## The guarantees, and where each one is enforced
 *
 *  - **Nothing reaches Shopee.** The client is the real one, but its `fetch` is
 *    the engine's replay (`lib/shopee/pedidos/reproduzirPedido.ts`), which
 *    answers the two captured paths and rejects everything else.
 *  - **Nothing reaches a Firestore.** The database is `FakeDb`, built here and
 *    seeded from the engine's `linhasDeSemente()`. This script is the ONE
 *    sanctioned non-test importer of `lib/shopee/testing/fakeDb.ts`, and it
 *    never imports the admin singleton.
 *  - **Nothing leaves the machine.** Before the engine is even loaded,
 *    `globalThis.fetch` is replaced by a guard that refuses every host — except
 *    `viacep.com.br`, and only under `--viacep`. A refused call is reported by
 *    HOST on stderr.
 *  - **Nothing printed carries a buyer value.** The report is an allow-list and
 *    is then SCANNED for the capture's own values (`montarSaidaDaReproducao` in
 *    `lib/shopee/pedidos/reproduzirPedidoCli.ts`): a hit withholds the whole
 *    report, and a leaking log line is suppressed. stdout is what gets pasted
 *    into a chat.
 *  - **Raw captures and the full-values output live outside every checkout.**
 *    `--detalhe`, `--escrow` and `--saida` must be ABSOLUTE, and are refused
 *    when any ancestor directory — of the path as typed or of its real
 *    location — holds a `.git` entry or a `pnpm-workspace.yaml`. `--saida`
 *    never overwrites.
 *
 * It needs NO environment: no `.env.local`, no credentials, no project. The
 * package script deliberately runs it without `dotenv`.
 *
 * ## Exit codes
 *
 * `0` on ANY import outcome — `ignorado-inexistente` included. `1` on a refused
 * argument, path or capture, a withheld report, or a throw (described by CLASS
 * and field paths, never a payload).
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';

import {
  ChamadaDeRedeBloqueadaError,
  USO_REPRODUZIR_PEDIDO,
  descreverErroReproducao,
  documentosParaSaida,
  exigirArquivoExistente,
  exigirForaDeCheckout,
  exigirSaidaNova,
  hostParaRelatorio,
  hostPermitidoNaReproducao,
  montarSaidaDaReproducao,
  parseArgsReproduzirPedido,
  urlDaRequisicao,
  viaCepDesligado,
} from '../lib/shopee/pedidos/reproduzirPedidoCli';

/** stdout — the redacted report, and nothing else. */
function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

/** stderr — the importer's scanned log lines, the warnings and the errors. */
function aviso(message: string): void {
  console.error(message);
}

async function main(): Promise<void> {
  const comando = parseArgsReproduzirPedido(process.argv.slice(2));
  if (comando.kind === 'ajuda') {
    log(USO_REPRODUZIR_PEDIDO);
    return;
  }
  const args = comando.args;

  // Every path is guarded BEFORE any file is read or written — over the path as
  // typed AND its real location, so a junction into a checkout is refused too.
  // `existsSync` sees a worktree's `.git` FILE as well as a clone's folder.
  const fs = { existe: existsSync, realpath: (c: string) => realpathSync.native(c) };
  const detalhe = exigirForaDeCheckout('--detalhe', args.detalhe, fs);
  exigirArquivoExistente('--detalhe', detalhe, existsSync);
  const escrow = args.escrow === null ? null : exigirForaDeCheckout('--escrow', args.escrow, fs);
  if (escrow !== null) exigirArquivoExistente('--escrow', escrow, existsSync);
  const saida = args.saida === null ? null : exigirForaDeCheckout('--saida', args.saida, fs);
  if (saida !== null) exigirSaidaNova(saida, existsSync);

  const detalheTexto = readFileSync(detalhe, 'utf8');
  const escrowTexto = escrow === null ? null : readFileSync(escrow, 'utf8');

  // The network guard — installed BEFORE the engine, the importer and the
  // in-memory database are loaded, so no module of that graph can reach the
  // network either.
  const hostsBloqueados: string[] = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = urlDaRequisicao(input);
    if (!hostPermitidoNaReproducao(url, args.viaCep)) {
      const host = hostParaRelatorio(url);
      hostsBloqueados.push(host);
      return Promise.reject(new ChamadaDeRedeBloqueadaError(host));
    }
    return fetchOriginal(input, init);
  };

  const { FakeDb, asDb } = await import('../lib/shopee/testing/fakeDb');
  const { linhasDeSemente, reproduzirPedidoShopee } =
    await import('../lib/shopee/pedidos/reproduzirPedido');

  const db = new FakeDb();
  for (const [caminho, dados] of linhasDeSemente()) db.seed(caminho, { ...dados });

  let viaCep;
  if (args.viaCep) {
    const { createViaCepClient } = await import('@delfrance/core/cep');
    viaCep = createViaCepClient();
  } else {
    viaCep = viaCepDesligado();
  }

  const resultado = await reproduzirPedidoShopee(asDb(db), {
    detalheTexto,
    escrowTexto,
    orderSn: args.orderSn,
    nowMs: Date.now(),
    viaCep,
  });

  if (saida !== null) {
    // `wx`: fails rather than overwrite, even if the file appeared after the check.
    writeFileSync(saida, documentosParaSaida(resultado), { encoding: 'utf8', flag: 'wx' });
  }

  const relatorio = montarSaidaDaReproducao(resultado, {
    viaCepLigado: args.viaCep,
    hostsBloqueados,
  });
  for (const linha of relatorio.stderr) aviso(linha);
  if (saida !== null) {
    aviso('');
    aviso(
      `⚠️ --saida gravado em ${saida}: ele CONTÉM os dados reais do comprador. Não cole, não ` +
        'envie e não commite esse arquivo; apague-o depois de ler.',
    );
  }
  for (const linha of relatorio.stdout) log(linha);
  if (relatorio.recusado) process.exitCode = 1;
}

await main().catch((err: unknown) => {
  // The describer is the tested half: a class and field paths, never a payload.
  for (const linha of descreverErroReproducao(err)) aviso(linha);
  process.exitCode = 1;
});
