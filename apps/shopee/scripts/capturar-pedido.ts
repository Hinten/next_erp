/**
 * Capture, from the PRODUCTION BR Shopee shop, the RAW bodies of the two reads
 * the step-5 importer makes for one order — the pair `reproduzir:pedido`
 * replays offline.
 *
 *   pnpm --filter @delfrance/shopee-app capturar:pedido \
 *     --order-sn <sn> --pasta <pasta absoluta> --nome <rótulo>
 *
 * ⚠️ A HUMAN runs this, never an agent (root CLAUDE.md rule 8): it calls the
 * live shop with the live legacy app's credentials. The runbook is
 * `scripts/README.md` §19.1.
 *
 * ## The guarantees, and where each one is enforced
 *
 *  - **Read-only, two requests, nothing else.** `globalThis.fetch` is replaced,
 *    FIRST, by `criarFetchGuardado` (`lib/shopee/pedidos/capturarPedidoCli.ts`,
 *    where its test pins it): only a `GET` to `https://openplatform.shopee.com.br`
 *    on the two importer paths goes out, and with `redirect: 'error'`, so no
 *    hop can leave the host the guard checked. The token endpoints live on that
 *    same host and are refused like everything else, so nothing here can renew
 *    the token: the access token is the environment's, returned verbatim.
 *  - **The importer's exact request.** The calls are made by
 *    `executarCaptura` through the REAL package client — its test pins the
 *    query against the importer's.
 *  - **The bytes Shopee sent.** Each file is written from the tee's raw text,
 *    never re-serialised, through `gravarSemSobrescrever`: an exclusive
 *    `.parcial` file, then a hard link to the final name (never over an
 *    existing file), then the partial is removed. A failed write leaves nothing
 *    under the final name and is REPORTED, not thrown past the report.
 *  - **Outside every checkout.** `--pasta` and both files go through the
 *    replay's own path guards, as typed AND behind any junction, before any
 *    credential is used.
 *  - **Nothing printed carries a value.** The report is built by name (paths,
 *    statuses, codes, counts, tokens, booleans); the URL, the token, the key,
 *    the sign and the shop id never reach a line.
 *
 * It reads ONLY the four `SHOPEE_CAP_*` variables, and the package script runs
 * it without loading any env file.
 *
 * ## Exit codes
 *
 * `0` when the detail body was saved — even if the escrow answered an error
 * envelope. `1` otherwise: a refused argument, path or credential, a stop
 * (auth, signature, IP, rate limit), a detail without the order, a failed
 * write, or a throw.
 *
 * ⚠️ The package module itself is evaluated by the static import below (as in
 * `reproduzir-pedido.ts`); it captures no `fetch` at load — a client reads one
 * only when it is BUILT, and this one is built over the tee, over the guard.
 */
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';

import {
  USO_CAPTURAR_PEDIDO,
  criarClienteDaCaptura,
  criarFetchEspelho,
  criarFetchGuardado,
  descreverErroCaptura,
  executarCaptura,
  exigirCaminhosDaCaptura,
  gravarSemSobrescrever,
  lerCredenciaisDaCaptura,
  montarSaidaDaCaptura,
  parseArgsCapturarPedido,
  type OperacoesDeGravacao,
} from '../lib/shopee/pedidos/capturarPedidoCli';

/** stdout — the value-free report, and nothing else. */
function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

/** stderr — the refusals and the errors. */
function aviso(message: string): void {
  console.error(message);
}

/** The writer's five steps, over `node:fs`. */
const FS_DA_GRAVACAO: OperacoesDeGravacao = {
  // `wx`: creates, and fails rather than open a file that already exists.
  criarExclusivo: (caminho) => openSync(caminho, 'wx'),
  escrever: (fd, texto) => {
    writeFileSync(fd, texto, { encoding: 'utf8' });
  },
  fechar: (fd) => {
    closeSync(fd);
  },
  // A hard link fails with EEXIST rather than overwrite.
  vincular: (de, para) => {
    linkSync(de, para);
  },
  remover: (caminho) => {
    rmSync(caminho, { force: true });
  },
};

async function main(): Promise<void> {
  // The network guard — FIRST, before an argument is read, a credential is
  // touched or a client exists. A refused request is named by method, host and
  // (on Shopee's host) API path; never by its URL.
  globalThis.fetch = criarFetchGuardado(globalThis.fetch);

  const comando = parseArgsCapturarPedido(process.argv.slice(2));
  if (comando.kind === 'ajuda') {
    log(USO_CAPTURAR_PEDIDO);
    return;
  }
  const args = comando.args;

  // Every path is guarded BEFORE a credential is read or a request leaves —
  // over the path as typed AND its real location. `existsSync` sees a
  // worktree's `.git` FILE as well as a clone's folder.
  const caminhos = exigirCaminhosDaCaptura(args, {
    existe: existsSync,
    realpath: (c: string) => realpathSync.native(c),
    tipo: (c: string) =>
      !existsSync(c) ? 'ausente' : statSync(c).isDirectory() ? 'diretorio' : 'outro',
  });

  // ONLY the four SHOPEE_CAP_* names are read off the environment.
  const credenciais = lerCredenciaisDaCaptura(process.env);

  // The tee wraps the GUARDED fetch, and the client is built over the tee.
  const espelho = criarFetchEspelho(globalThis.fetch);
  const client = criarClienteDaCaptura(credenciais, espelho.fetch);

  const resultado = await executarCaptura({
    client,
    respostas: espelho.respostas,
    orderSn: args.orderSn,
    gravar: (papel, texto) =>
      gravarSemSobrescrever(
        papel === 'detalhe' ? caminhos.detalhe : caminhos.escrow,
        texto,
        FS_DA_GRAVACAO,
      ),
  });

  const saida = montarSaidaDaCaptura(resultado, caminhos);
  for (const linha of saida.linhas) log(linha);
  process.exitCode = saida.codigo;
}

await main().catch((err: unknown) => {
  // The describer is the tested half: a class, a code, a path — never a payload.
  for (const linha of descreverErroCaptura(err)) aviso(linha);
  process.exitCode = 1;
});
