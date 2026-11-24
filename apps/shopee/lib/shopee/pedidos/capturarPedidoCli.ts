/**
 * The pure half of `scripts/capturar-pedido.ts` — the read-only CAPTURE of the
 * two raw response bodies `reproduzir:pedido` replays.
 *
 * ⚠️ It lives here rather than in the script because `scripts/` is outside this
 * app's vitest `include` (the `reproduzirPedidoCli.ts` precedent, whose path
 * guards this module IMPORTS rather than copies). Nothing here reads the
 * environment, a file or a clock: the environment, the filesystem probes, the
 * writer and the underlying `fetch` are all parameters.
 *
 * ## Fidelity by construction
 *
 * A replay is only worth what its capture is worth: a body captured with a
 * different `response_optional_fields` describes the capture, not the order.
 * So this module does not RE-STATE the importer's request — it MAKES it, through
 * the same package client the importer uses ({@link executarCaptura}):
 *
 *  - `getOrderDetail({ orderSnList: [orderSn], requestOrderStatusPending: true })`
 *    with NO `responseOptionalFields`, so the package's own default
 *    (`SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS`) is what goes out — the call
 *    `prepararImportacaoPedidoShopee` makes, parameter for parameter;
 *  - `getEscrowDetail({ orderSn })`, whose verb and placement are the
 *    package's `SHOPEE_ESCROW_DETAIL_TRANSPORT`.
 *
 * `capturarPedidoCli.test.ts` records both calls AND the importer's over the
 * same kind of stub and pins the query parameter sets equal, so the two cannot
 * drift apart.
 *
 * ## What is saved: the bytes Shopee sent, never a re-serialisation
 *
 * The client's `fetch` is a TEE ({@link criarFetchEspelho}): it calls the real
 * `fetch`, reads a CLONE of the body as text and hands the untouched response
 * back to the client. That text is what gets written — also when the client
 * then throws on it, because a schema mismatch is exactly what the replay must
 * be able to show. A file is saved only when the replay can USE it: an escrow
 * answering a failure the importer does not contain (a rate limit, a dead
 * grant — `escrowNaoContido.ts`, the importer's own list) is not saved, because
 * the replay would rethrow it.
 *
 * Each file is written ATOMICALLY and never over another
 * ({@link gravarSemSobrescrever}): an exclusive `.parcial` file, then a hard
 * link to the final name (which fails rather than overwrite), then the partial
 * is removed. A failed write leaves nothing under the final name, and the
 * failure is REPORTED (code and path) rather than thrown past the report.
 *
 * ## What is never printed
 *
 * The URL (its query carries `access_token` and `sign`), the token, the partner
 * key, the shop id, a body, or Shopee's `message` (it can echo request data).
 * Every printed line is built BY NAME from an API path, an HTTP status, a
 * token-shaped error code, a count, a closed-shape token or a boolean. The
 * package's own console lines are swallowed during the two calls — a non-JSON
 * body is logged by the package WITH an excerpt — and only COUNTED.
 *
 * ## What it never does
 *
 * It never renews the token, and there is no renewal path to reach: the access
 * token is the environment's, returned verbatim by `getAccessToken`, and the
 * script's network guard ({@link criarFetchGuardado}) lets exactly the two GET
 * paths above through, to the production host only, and follows no redirect —
 * so even the package's own token endpoints are unreachable from that process,
 * and no hop can leave the host the guard checked. It opens no
 * Firestore, and it reads none of this app's own Shopee variables (those belong
 * to the STAGING sandbox app): the four `SHOPEE_CAP_*` values are the live
 * legacy app's, typed into one PowerShell window (`scripts/README.md` §19.1).
 */
import nodePath from 'node:path';
import {
  SHOPEE_GET_ESCROW_DETAIL_PATH,
  SHOPEE_GET_ORDER_DETAIL_PATH,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  createShopeeClient,
  resolveShopeeHosts,
  shopeeCodigoCanonico,
  type ShopeeClient,
  type ShopeeHosts,
} from '@delfrance/integrations-shopee';

import {
  ArgumentoInvalidoError,
  ArquivoRecusadoError,
  exigirForaDeCheckout,
  exigirSaidaNova,
  urlDaRequisicao,
  type DepsDoCaminho,
} from './reproduzirPedidoCli';
import { falhaDeEscrowNaoContida } from './escrowNaoContido';

export { ArgumentoInvalidoError, ArquivoRecusadoError, urlDaRequisicao };

/* -------------------------------------------------------------------------- */
/*                                    errors                                   */
/* -------------------------------------------------------------------------- */

/** One refused `SHOPEE_CAP_*` variable — its NAME and why, never its value. */
export interface ProblemaDeCredencial {
  readonly variavel: string;
  readonly motivo: string;
}

/** The four credentials, refused. The message names VARIABLES only. */
export class CredencialDaCapturaError extends Error {
  readonly variaveis: readonly string[];
  constructor(problemas: readonly ProblemaDeCredencial[]) {
    super(
      [
        'Credenciais da captura recusadas (nenhum valor é repetido aqui):',
        ...problemas.map((p) => `  - ${p.variavel}: ${p.motivo}`),
        'Defina as quatro na MESMA janela do PowerShell (scripts/README.md §19.1) e rode de novo.',
      ].join('\n'),
    );
    this.name = 'CredencialDaCapturaError';
    this.variaveis = problemas.map((p) => p.variavel);
  }
}

/**
 * The script's network guard refused a request. Carries the method, the host
 * and — on the production host only — the API path. Never the query: it holds
 * the token and the sign.
 */
export class RequisicaoBloqueadaNaCapturaError extends Error {
  readonly alvo: string;
  constructor(alvo: string) {
    super(`a captura bloqueou uma requisição: ${alvo}`);
    this.name = 'RequisicaoBloqueadaNaCapturaError';
    this.alvo = alvo;
  }
}

/* -------------------------------------------------------------------------- */
/*                                  arguments                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ No `--` separator in the documented invocation: pnpm forwards that token
 * into the script (`packages/config-eslint/rules/pnpm-run-args.test.js`).
 */
export const USO_CAPTURAR_PEDIDO = `
Captura, da loja BR de PRODUÇÃO, os corpos CRUS das duas leituras que o
importador do step 5 faz para uma order — o par que o reproduzir:pedido usa.
Somente leitura: get_order_detail e get_escrow_detail, e nada mais. Nunca
renova o token.

  pnpm --filter @delfrance/shopee-app capturar:pedido \\
    --order-sn <sn> --pasta <pasta> --nome <rótulo>

Obrigatório
  --order-sn <sn>   a order (letras MAIÚSCULAS e dígitos, 6 a 32 caracteres)
  --pasta <pasta>   uma pasta que JÁ EXISTE, em caminho ABSOLUTO, fora de
                    qualquer checkout e fora do OneDrive
  --nome <rótulo>   o nome dos dois arquivos: <rótulo>.detalhe.json e
                    <rótulo>.escrow.json (a-z, 0-9 e hífen, até 40).
                    Nunca sobrescreve: use um rótulo novo por captura.
  --help, -h        mostra esta ajuda e sai com 0

Credenciais: SÓ estas quatro variáveis, definidas na janela do PowerShell
(apps/shopee/scripts/README.md §19.1). O script não lê arquivo .env nenhum.
  SHOPEE_CAP_PARTNER_ID     SHOPEE_CAP_PARTNER_KEY
  SHOPEE_CAP_SHOP_ID        SHOPEE_CAP_ACCESS_TOKEN

Num erro de autorização, de assinatura ou de IP: PARE. Não renove o token e
não mude nada no Console da Shopee.
`.trim();

export interface ArgsCapturarPedido {
  readonly orderSn: string;
  /** As typed — the path guard resolves it and refuses a relative one. */
  readonly pasta: string;
  readonly nome: string;
}

export type ComandoCapturarPedido =
  | { readonly kind: 'ajuda' }
  | { readonly kind: 'capturar'; readonly args: ArgsCapturarPedido };

/** What an unknown token must look like for the refusal to NAME it. */
const FORMA_DE_FLAG = /^--?[a-z][a-z-]*$/i;

/**
 * The `order_sn` this CLI accepts — STRICTER than the package's `assertOrderSn`,
 * which refuses only a blank. Every documented and observed `order_sn`
 * (`220810QSK8S7BX`, the 14-character SG fixture) is upper-case letters and
 * digits; anything else is a typo or a pasted fragment, and the value lands in
 * a signed URL. Refusing is the only effect: nothing is ever rewritten.
 */
export const FORMA_ORDER_SN = /^[A-Z0-9]{6,32}$/;

/** The file label: lower-case letters, digits and hyphens — a name, never a path. */
export const FORMA_NOME = /^[a-z0-9-]{1,40}$/;

function valorDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const bruto = (inline ?? proximo)?.trim();
  if (bruto == null || bruto.length === 0 || bruto.startsWith('--')) {
    throw new ArgumentoInvalidoError(`${nome} exige um valor.`);
  }
  return bruto;
}

/**
 * Parse the command line. Pure. `--help` wins before anything is validated.
 *
 * ⚠️ Flags are matched EXACTLY, each value flag at most once, and no refusal
 * repeats a VALUE (a token or a path typed in the wrong place would otherwise
 * land in the error line).
 */
export function parseArgsCapturarPedido(argv: readonly string[]): ComandoCapturarPedido {
  if (argv.some((a) => a === '--help' || a === '-h')) return { kind: 'ajuda' };

  const valores = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      throw new ArgumentoInvalidoError(
        'Separador "--" recebido como argumento: o pnpm repassa esse token para o script. ' +
          'Remova-o e passe as flags direto (veja --help).',
      );
    }
    const igual = arg.indexOf('=');
    const nome = igual === -1 ? arg : arg.slice(0, igual);
    const inline = igual === -1 ? undefined : arg.slice(igual + 1);
    switch (nome) {
      case '--order-sn':
      case '--pasta':
      case '--nome': {
        if (valores.has(nome)) throw new ArgumentoInvalidoError(`${nome} informado duas vezes.`);
        valores.set(nome, valorDe(nome, inline, argv[i + 1]));
        if (inline === undefined) i += 1;
        break;
      }
      default:
        throw new ArgumentoInvalidoError(
          FORMA_DE_FLAG.test(nome)
            ? `Opção desconhecida: ${nome}${inline === undefined ? '' : '=…'}`
            : 'Argumento solto, sem flag (o valor não é repetido aqui): passe cada valor logo ' +
                'depois da sua flag (veja --help).',
        );
    }
  }

  const orderSn = valores.get('--order-sn');
  const pasta = valores.get('--pasta');
  const nome = valores.get('--nome');
  if (orderSn === undefined) throw new ArgumentoInvalidoError('--order-sn <sn> é obrigatório.');
  if (pasta === undefined) throw new ArgumentoInvalidoError('--pasta <pasta> é obrigatório.');
  if (nome === undefined) throw new ArgumentoInvalidoError('--nome <rótulo> é obrigatório.');
  if (!FORMA_ORDER_SN.test(orderSn)) {
    throw new ArgumentoInvalidoError(
      '--order-sn tem de ser letras MAIÚSCULAS e dígitos, de 6 a 32 caracteres (o valor não é ' +
        'repetido aqui). Copie o número da order como a Shopee o mostra.',
    );
  }
  if (!FORMA_NOME.test(nome)) {
    throw new ArgumentoInvalidoError(
      '--nome tem de ser só letras minúsculas, dígitos e hífen, até 40 caracteres ' +
        '(ex.: pedido-cpf-1) — é o nome dos arquivos, nunca um caminho.',
    );
  }
  return { kind: 'capturar', args: { orderSn, pasta, nome } };
}

/* -------------------------------------------------------------------------- */
/*                                 credentials                                 */
/* -------------------------------------------------------------------------- */

/**
 * The ONLY four environment variables this capture reads — the names the BR
 * capture runbook already uses. ⚠️ Never this app's own Shopee variables: those
 * belong to the staging sandbox app, and the BR shop is authorised on the live
 * legacy app only.
 */
export const VARIAVEIS_DA_CAPTURA = {
  partnerId: 'SHOPEE_CAP_PARTNER_ID',
  partnerKey: 'SHOPEE_CAP_PARTNER_KEY',
  shopId: 'SHOPEE_CAP_SHOP_ID',
  accessToken: 'SHOPEE_CAP_ACCESS_TOKEN',
} as const;

export interface CredenciaisDaCaptura {
  readonly partnerId: number;
  readonly partnerKey: string;
  readonly shopId: number;
  readonly accessToken: string;
}

/** A Shopee id as typed: digits only, no leading zero (the runbook's own rule). */
const ID_DECIMAL = /^[1-9][0-9]*$/;

/**
 * Read the four credentials out of `env` — and nothing else out of it: each
 * name in {@link VARIAVEIS_DA_CAPTURA} is read once, and no other key is
 * touched (a test proxies `env` to prove it).
 *
 * Every value is trimmed. The ids must be digits with no leading zero and a
 * positive safe integer; the key and the token must be non-empty with no
 * whitespace inside. Every problem is collected, and the ONE refusal names
 * each VARIABLE — never a value, not even a prefix of one.
 */
export function lerCredenciaisDaCaptura(
  env: Readonly<Record<string, string | undefined>>,
): CredenciaisDaCaptura {
  const problemas: ProblemaDeCredencial[] = [];

  const texto = (variavel: string): string | null => {
    const bruto = env[variavel];
    const aparado = typeof bruto === 'string' ? bruto.trim() : '';
    if (aparado.length === 0) {
      problemas.push({ variavel, motivo: 'não definida, ou vazia, nesta janela' });
      return null;
    }
    return aparado;
  };
  const id = (variavel: string): number | null => {
    const v = texto(variavel);
    if (v === null) return null;
    if (!ID_DECIMAL.test(v)) {
      problemas.push({
        variavel,
        motivo: 'tem de ser só dígitos, sem zero à esquerda, sem aspas e sem espaço',
      });
      return null;
    }
    const n = Number(v);
    if (!Number.isSafeInteger(n)) {
      problemas.push({ variavel, motivo: 'grande demais para um id (passa do inteiro seguro)' });
      return null;
    }
    return n;
  };
  const segredo = (variavel: string): string | null => {
    const v = texto(variavel);
    if (v === null) return null;
    if (/\s/.test(v)) {
      problemas.push({
        variavel,
        motivo: 'tem espaço ou quebra de linha no meio — cole de novo só o valor',
      });
      return null;
    }
    return v;
  };

  const partnerId = id(VARIAVEIS_DA_CAPTURA.partnerId);
  const partnerKey = segredo(VARIAVEIS_DA_CAPTURA.partnerKey);
  const shopId = id(VARIAVEIS_DA_CAPTURA.shopId);
  const accessToken = segredo(VARIAVEIS_DA_CAPTURA.accessToken);
  if (partnerId === null || partnerKey === null || shopId === null || accessToken === null) {
    throw new CredencialDaCapturaError(problemas);
  }
  return { partnerId, partnerKey, shopId, accessToken };
}

/* -------------------------------------------------------------------------- */
/*                               the path guards                               */
/* -------------------------------------------------------------------------- */

/** What the directory probe answers — `statSync` in the script, a map in the tests. */
export type TipoDoCaminho = 'diretorio' | 'outro' | 'ausente';

export interface DepsDaPasta extends DepsDoCaminho {
  readonly tipo: (caminho: string) => TipoDoCaminho;
}

export interface CaminhosDaCaptura {
  readonly pasta: string;
  readonly detalhe: string;
  readonly escrow: string;
}

const PAPEL_DETALHE = '<nome>.detalhe.json';
const PAPEL_ESCROW = '<nome>.escrow.json';

/** The suffix of the exclusive scratch file {@link gravarSemSobrescrever} writes first. */
export const SUFIXO_PARCIAL = '.parcial';

/** `<destino>.parcial` — beside the final file, so the same path guard covers it. */
export function caminhoParcial(destino: string): string {
  return `${destino}${SUFIXO_PARCIAL}`;
}

/**
 * Refuse the folder and the two output files BEFORE any credential is used or
 * any request leaves — through the replay's own guards (imported, never
 * copied): `--pasta` and each file must sit outside every checkout, as typed
 * AND behind any junction; `--pasta` must already exist and be a directory;
 * neither file may exist yet, and neither may its `.parcial` (a leftover of an
 * interrupted capture, holding buyer data) — the writer ALSO creates both
 * exclusively, so this is the early, cheap half of the same refusal.
 */
export function exigirCaminhosDaCaptura(
  args: Pick<ArgsCapturarPedido, 'pasta' | 'nome'>,
  deps: DepsDaPasta,
): CaminhosDaCaptura {
  const p = deps.caminhos ?? nodePath;
  const pasta = exigirForaDeCheckout('--pasta', args.pasta, deps);
  const tipo = deps.tipo(pasta);
  if (tipo === 'ausente') {
    throw new ArquivoRecusadoError(
      '--pasta não existe. Crie-a antes, num caminho ABSOLUTO fora de qualquer checkout e fora ' +
        'do OneDrive — a captura nunca cria pastas.',
    );
  }
  if (tipo === 'outro') {
    throw new ArquivoRecusadoError('--pasta não é uma pasta (é um arquivo ou outra coisa).');
  }
  const detalhe = exigirForaDeCheckout(
    PAPEL_DETALHE,
    p.join(pasta, `${args.nome}.detalhe.json`),
    deps,
  );
  const escrow = exigirForaDeCheckout(
    PAPEL_ESCROW,
    p.join(pasta, `${args.nome}.escrow.json`),
    deps,
  );
  exigirSaidaNova(detalhe, deps.existe, PAPEL_DETALHE);
  exigirSaidaNova(escrow, deps.existe, PAPEL_ESCROW);
  for (const [papel, destino] of [
    [PAPEL_DETALHE, detalhe],
    [PAPEL_ESCROW, escrow],
  ] as const) {
    if (deps.existe(caminhoParcial(destino))) {
      throw new ArquivoRecusadoError(
        `${papel}${SUFIXO_PARCIAL} sobrou de uma captura interrompida e tem dados do comprador: ` +
          'apague-o (ou use outro --nome) e rode de novo.',
      );
    }
  }
  return { pasta, detalhe, escrow };
}

/* -------------------------------------------------------------------------- */
/*                                 the writer                                  */
/* -------------------------------------------------------------------------- */

/** The five filesystem steps {@link gravarSemSobrescrever} takes — `node:fs` in the script. */
export interface OperacoesDeGravacao {
  /** `openSync(caminho, 'wx')` — creates the file, and fails if it already exists. */
  readonly criarExclusivo: (caminho: string) => number;
  readonly escrever: (fd: number, texto: string) => void;
  readonly fechar: (fd: number) => void;
  /** `linkSync(de, para)` — a hard link; fails with `EEXIST` rather than overwrite. */
  readonly vincular: (de: string, para: string) => void;
  readonly remover: (caminho: string) => void;
}

/** What one write did — reported, never thrown past the report. */
export interface ResultadoDaGravacao {
  /** The file is on disk under its FINAL name, complete. */
  readonly salvo: boolean;
  /** The system error code of the step that failed — `null` when none did. */
  readonly codigo: string | null;
  /** The `.parcial` file that could not be removed — `null` when none is left. */
  readonly parcialRestante: string | null;
}

/**
 * A Node system error's `code` (`ENOSPC`, `EEXIST`, `EPERM`, `UNKNOWN`), or
 * `null` when `err` is not one.
 *
 * ⚠️ Rule 6's narrowing, by SHAPE: Node exports no class for its system errors,
 * and `instanceof Error` narrows nothing. What every one of them carries — and a
 * bug (`TypeError`, a `RangeError`) does not — is a string `code`, a numeric
 * `errno` and a string `syscall`. Anything without all three is rethrown by the
 * caller.
 */
function codigoDeErroDeSistema(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as {
    readonly code?: unknown;
    readonly errno?: unknown;
    readonly syscall?: unknown;
  };
  return typeof e.code === 'string' &&
    /^[A-Z][A-Z0-9_]{1,31}$/.test(e.code) &&
    typeof e.errno === 'number' &&
    typeof e.syscall === 'string'
    ? e.code
    : null;
}

/**
 * Write `texto` to `destino` ATOMICALLY and never over an existing file:
 *
 *  1. create `<destino>.parcial` EXCLUSIVELY (so the partial is provably ours);
 *  2. write the text into it and close it;
 *  3. hard-link it to `destino` — `EEXIST` rather than overwrite, and either the
 *     whole file appears under the final name or nothing does;
 *  4. remove the partial, ALWAYS (in a `finally`).
 *
 * A system error at any step is RETURNED (its code), so the report still says
 * which file was saved, which was not, and which partial — buyer data — is left
 * to delete. A failure at step 1 removes nothing: a file that existed before is
 * never ours to delete. Anything that is not a system error is rethrown.
 */
export function gravarSemSobrescrever(
  destino: string,
  texto: string,
  fs: OperacoesDeGravacao,
): ResultadoDaGravacao {
  const parcial = caminhoParcial(destino);
  let fd: number;
  try {
    fd = fs.criarExclusivo(parcial);
  } catch (err) {
    const codigo = codigoDeErroDeSistema(err);
    if (codigo === null) throw err;
    return { salvo: false, codigo, parcialRestante: null };
  }

  let codigo: string | null = null;
  let parcialRestante: string | null = null;
  try {
    try {
      try {
        fs.escrever(fd, texto);
      } finally {
        fs.fechar(fd);
      }
      fs.vincular(parcial, destino);
    } catch (err) {
      codigo = codigoDeErroDeSistema(err);
      if (codigo === null) throw err;
    }
  } finally {
    try {
      fs.remover(parcial);
    } catch (err) {
      if (codigoDeErroDeSistema(err) === null) throw err;
      parcialRestante = parcial;
    }
  }
  return { salvo: codigo === null, codigo, parcialRestante };
}

/* -------------------------------------------------------------------------- */
/*                              the network guard                              */
/* -------------------------------------------------------------------------- */

/**
 * The PRODUCTION hosts, exactly as `resolveShopeeHosts` builds them for
 * production — no sandbox flag, no override. Never the sandbox app's.
 */
export const HOSTS_DA_CAPTURA: ShopeeHosts = resolveShopeeHosts({ sandbox: false });

/** The one host a capture request may reach (`openplatform.shopee.com.br`). */
export const HOST_DA_CAPTURA: string = new URL(HOSTS_DA_CAPTURA.apiHost).hostname;

/** The two API paths a capture request may hit — the importer's two reads. */
export const CAMINHOS_DA_CAPTURA: readonly string[] = [
  SHOPEE_GET_ORDER_DETAIL_PATH,
  SHOPEE_GET_ESCROW_DETAIL_PATH,
];

function urlOuNull(url: string): URL | null {
  try {
    return new URL(url);
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

/**
 * Whether a URL targets the production API host and nothing else: `https`, the
 * EXACT hostname, the default port, no credentials in the URL. A look-alike, a
 * sibling subdomain, plain `http`, a userinfo trick, the sandbox host or an
 * unparseable URL are all refused.
 */
export function hostPermitidoNaCaptura(url: string): boolean {
  const u = urlOuNull(url);
  return (
    u !== null &&
    u.protocol === 'https:' &&
    u.hostname === HOST_DA_CAPTURA &&
    u.port === '' &&
    u.username === '' &&
    u.password === ''
  );
}

/**
 * The script's whole `fetch` guard: the production host ({@link
 * hostPermitidoNaCaptura}), the verb `GET`, and one of the two
 * {@link CAMINHOS_DA_CAPTURA}. ⚠️ The path half is what makes "read-only, never
 * renews" structural rather than a promise: the token endpoints live on the
 * SAME host, so a host-only guard would let a renewal through.
 */
export function requisicaoPermitidaNaCaptura(url: string, metodo: string): boolean {
  if (!hostPermitidoNaCaptura(url) || metodo !== 'GET') return false;
  const u = urlOuNull(url);
  return u !== null && CAMINHOS_DA_CAPTURA.includes(u.pathname);
}

/** The verb of a `fetch` call, upper-cased — `GET` when none was given. */
export function metodoDaRequisicao(input: string | URL | Request, init?: RequestInit): string {
  const metodo = init?.method ?? (input instanceof Request ? input.method : 'GET');
  return metodo.toUpperCase();
}

/**
 * A refused request, for the error line: the method, the host and — on the
 * production host only — the API path. Never the query.
 */
export function alvoParaRelatorio(url: string, metodo: string): string {
  const verbo = /^[A-Z]{1,10}$/.test(metodo) ? metodo : '(método ilegível)';
  const u = urlOuNull(url);
  if (u === null) return `${verbo} (url ilegível)`;
  const host = u.hostname || '(sem host)';
  return u.hostname === HOST_DA_CAPTURA ? `${verbo} ${host}${u.pathname}` : `${verbo} ${host}`;
}

/**
 * The script's whole network guard, installed over `globalThis.fetch` before
 * anything else runs: a request {@link requisicaoPermitidaNaCaptura} refuses is
 * rejected without reaching `fetchOriginal`, and an allowed one goes out with
 * `redirect: 'error'`.
 *
 * ⚠️ The redirect mode is what makes the guard cover every HOP, not just the
 * first. `fetch` follows a 3xx by default (up to 20 hops) without calling the
 * guard again, and a canonicalising redirect that kept the query would carry the
 * access token and the sign to wherever `Location` pointed — another host, plain
 * `http`, another path — while the tee filed that body under the ORIGINAL path.
 * With `'error'` a 3xx rejects (the client's `ShopeeNetworkError`, nothing
 * saved). A response that still says `redirected` is refused as well, in case
 * the underlying `fetch` ignored the mode.
 */
export function criarFetchGuardado(
  fetchOriginal: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = urlDaRequisicao(input);
    const metodo = metodoDaRequisicao(input, init);
    if (!requisicaoPermitidaNaCaptura(url, metodo)) {
      throw new RequisicaoBloqueadaNaCapturaError(alvoParaRelatorio(url, metodo));
    }
    const semRedirecionamento: RequestInit = { ...init, redirect: 'error' };
    const res = await fetchOriginal(input, semRedirecionamento);
    if (res.redirected) {
      throw new RequisicaoBloqueadaNaCapturaError(
        `${alvoParaRelatorio(url, metodo)} (redirecionada — recusada)`,
      );
    }
    return res;
  };
}

/* -------------------------------------------------------------------------- */
/*                                   the tee                                   */
/* -------------------------------------------------------------------------- */

/** One response the client received — its API PATH, status and raw text. Never the URL. */
export interface RespostaEspelhada {
  readonly path: string;
  readonly status: number;
  readonly texto: string;
}

/**
 * The client's `fetch`: call `fetchReal`, read a CLONE of the body as text, and
 * return the ORIGINAL response untouched — so the client parses exactly what it
 * would have parsed, and `respostas` holds exactly what Shopee sent.
 *
 * A request that gets no response (a network failure, the guard) records
 * nothing and rejects as it would have; the client turns that into its
 * `ShopeeNetworkError`. A body that dies mid-read rejects the same way.
 */
export function criarFetchEspelho(fetchReal: typeof globalThis.fetch): {
  readonly fetch: typeof globalThis.fetch;
  readonly respostas: readonly RespostaEspelhada[];
} {
  const respostas: RespostaEspelhada[] = [];
  const espelho: typeof globalThis.fetch = async (input, init) => {
    const res = await fetchReal(input, init);
    const texto = await res.clone().text();
    respostas.push({ path: new URL(urlDaRequisicao(input)).pathname, status: res.status, texto });
    return res;
  };
  return { fetch: espelho, respostas };
}

/* -------------------------------------------------------------------------- */
/*                                  the client                                 */
/* -------------------------------------------------------------------------- */

/**
 * The REAL package client, on the production hosts, over `fetch` (the tee).
 * `getAccessToken` returns the environment's token VERBATIM — nothing renews
 * it, and nothing could: see the module header.
 */
export function criarClienteDaCaptura(
  credenciais: CredenciaisDaCaptura,
  fetch: typeof globalThis.fetch,
  opcoes: { readonly now?: () => number } = {},
): ShopeeClient {
  return createShopeeClient({
    partnerId: credenciais.partnerId,
    partnerKey: credenciais.partnerKey,
    hosts: HOSTS_DA_CAPTURA,
    shopId: credenciais.shopId,
    getAccessToken: () => Promise.resolve(credenciais.accessToken),
    fetch,
    ...(opcoes.now === undefined ? {} : { now: opcoes.now }),
  });
}

/* -------------------------------------------------------------------------- */
/*                              reading a raw body                             */
/* -------------------------------------------------------------------------- */

function objeto(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** The parsed body, or `undefined` when it is not JSON. */
function lerJson(texto: string): unknown {
  try {
    return JSON.parse(texto) as unknown;
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

/** A Shopee error code worth printing: a short dotted/underscored token. */
const FORMA_CODIGO = /^[A-Za-z0-9_.]{1,64}$/;
const FORMA_REGIAO = /^[A-Z]{2}$/;
const FORMA_STATUS = /^[A-Z_]{1,40}$/;

/** A value shown only when it matches a closed TOKEN shape — never free text. */
function token(v: unknown, forma: RegExp): string {
  if (v === undefined || v === null || v === '') return '(ausente)';
  return typeof v === 'string' && forma.test(v) ? v : '(formato inesperado)';
}

/** The envelope's `error`, as the report may print it. */
export function codigoDoEnvelope(texto: string): string {
  const corpo = lerJson(texto);
  if (corpo === undefined) return '(corpo não é JSON)';
  const envelope = objeto(corpo);
  if (envelope === null || (!('error' in envelope) && !('response' in envelope))) {
    return '(não é um envelope da Shopee)';
  }
  const erro = envelope.error;
  if (erro === undefined || erro === null || erro === '') return '(vazio)';
  return typeof erro === 'string' && FORMA_CODIGO.test(erro) ? erro : '(formato inesperado)';
}

/**
 * Whether the text is a Shopee ENVELOPE — a JSON object with `error` or
 * `response` at the top. The replay refuses anything else, so a body that is
 * not one (an edge HTML page) is never saved as the escrow.
 */
export function ehEnvelope(texto: string): boolean {
  const envelope = objeto(lerJson(texto));
  return envelope !== null && ('error' in envelope || 'response' in envelope);
}

/** What the report says about a `get_order_detail` body — counts, tokens and booleans. */
export interface ResumoDoDetalhe {
  /** Entries in `response.order_list`, or `null` when there is no such list. */
  readonly linhas: number | null;
  /** A row with the asked `order_sn` is there. */
  readonly linhaDaOrder: boolean;
  /** That row's tokens and key presence — `null` without the row. */
  readonly linha: {
    readonly regiao: string;
    readonly orderStatus: string;
    readonly recipientAddress: boolean;
    readonly buyerCpfId: boolean;
    readonly itemList: boolean;
  } | null;
}

export function resumoDoDetalhe(texto: string, orderSn: string): ResumoDoDetalhe {
  const resposta = objeto(objeto(lerJson(texto))?.response);
  const lista = resposta?.order_list;
  if (!Array.isArray(lista)) return { linhas: null, linhaDaOrder: false, linha: null };
  const linha = lista.map(objeto).find((l) => l !== null && l.order_sn === orderSn) ?? null;
  return {
    linhas: lista.length,
    linhaDaOrder: linha !== null,
    linha:
      linha === null
        ? null
        : {
            regiao: token(linha.region, FORMA_REGIAO),
            orderStatus: token(linha.order_status, FORMA_STATUS),
            recipientAddress: Object.hasOwn(linha, 'recipient_address'),
            buyerCpfId: Object.hasOwn(linha, 'buyer_cpf_id'),
            itemList: Object.hasOwn(linha, 'item_list'),
          },
  };
}

/* -------------------------------------------------------------------------- */
/*                                 the capture                                 */
/* -------------------------------------------------------------------------- */

export type PapelDaCaptura = 'detalhe' | 'escrow';

export interface ChamadaDaCaptura {
  readonly papel: PapelDaCaptura;
  /** What the tee saw — `null` when no response arrived at all. */
  readonly resposta: RespostaEspelhada | null;
  /** What the client threw — `null` when it parsed the body. A package error only. */
  readonly erro: ShopeeError | null;
  /** What the writer did — `null` when this body was not worth writing. */
  readonly gravacao: ResultadoDaGravacao | null;
  /** The file is on disk under its final name, complete. */
  readonly salva: boolean;
}

export interface ResultadoDaCaptura {
  readonly detalhe: ChamadaDaCaptura;
  /** The detail body's summary — `null` when no detail body arrived. */
  readonly resumoDoDetalhe: ResumoDoDetalhe | null;
  /** `null` when the detail was not SAVED: the escrow was never asked. */
  readonly escrow: ChamadaDaCaptura | null;
  /** The package's console lines swallowed during the calls — counted, never printed. */
  readonly linhasDeLogSuprimidas: number;
}

/**
 * Run `fn` with the four console methods replaced by a COUNTER, restored in
 * `finally`. The package logs a non-JSON body with an excerpt, and an edge page
 * is not ours to vouch for.
 */
async function comConsoleContido<T>(contador: { n: number }, fn: () => Promise<T>): Promise<T> {
  /* eslint-disable no-console -- the counter REPLACES the console methods; it never prints */
  const originais = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const contar = (): void => {
    contador.n += 1;
  };
  console.log = contar;
  console.info = contar;
  console.warn = contar;
  console.error = contar;
  try {
    return await fn();
  } finally {
    console.log = originais.log;
    console.info = originais.info;
    console.warn = originais.warn;
    console.error = originais.error;
  }
  /* eslint-enable no-console */
}

export interface EntradaDaCaptura {
  /** Built over the tee whose `respostas` is below ({@link criarClienteDaCaptura}). */
  readonly client: ShopeeClient;
  readonly respostas: readonly RespostaEspelhada[];
  readonly orderSn: string;
  /**
   * Writes ONE raw text — {@link gravarSemSobrescrever} over `node:fs` in the
   * script — and REPORTS the outcome; it throws only on a bug.
   */
  readonly gravar: (papel: PapelDaCaptura, texto: string) => ResultadoDaGravacao;
}

/**
 * Whether a captured escrow body can be REPLAYED: a Shopee envelope at all, and
 * not a failure the importer rethrows ({@link falhaDeEscrowNaoContida} — the
 * importer's own list). A rate-limit or dead-grant envelope served back to the
 * importer would fail the replay the report tells the operator to run.
 */
export function escrowReproduzivel(c: Pick<ChamadaDaCaptura, 'resposta' | 'erro'>): boolean {
  return c.resposta !== null && ehEnvelope(c.resposta.texto) && !falhaDeEscrowNaoContida(c.erro);
}

/**
 * The capture, in order:
 *
 *  1. `get_order_detail`, exactly as the importer asks it. The detail is
 *     SAVED when a body arrived that carries the asked order's row and the
 *     client either parsed it or refused it on the SCHEMA (the replay then
 *     shows that refusal by field path). Anything else — an auth, signature,
 *     IP or rate-limit refusal, any other Shopee error, an edge page, no
 *     response, a list without the order — saves nothing and asks NOTHING
 *     else: the run ends there. So does a detail whose WRITE failed.
 *  2. Only after the detail is on disk, `get_escrow_detail`. Its body is saved
 *     when the replay can serve it ({@link escrowReproduzivel}) — a success, an
 *     error envelope the importer contains (an unpaid order), a schema
 *     mismatch — and not when it is no envelope at all, or a rate limit or a
 *     dead grant the importer would rethrow.
 *
 * Nothing is retried, and the writer is called at most once per file.
 */
export async function executarCaptura(e: EntradaDaCaptura): Promise<ResultadoDaCaptura> {
  const contador = { n: 0 };

  // ONE request per call: the package retries nothing, so the response a call
  // got (if any) is the one entry the tee appended while it ran.
  const chamar = async (
    fn: () => Promise<unknown>,
  ): Promise<{
    readonly resposta: RespostaEspelhada | null;
    readonly erro: ShopeeError | null;
  }> => {
    const antes = e.respostas.length;
    let erro: ShopeeError | null = null;
    try {
      await comConsoleContido(contador, fn);
    } catch (err) {
      if (!(err instanceof ShopeeError)) throw err;
      erro = err;
    }
    const resposta =
      e.respostas.length > antes ? (e.respostas[e.respostas.length - 1] ?? null) : null;
    return { resposta, erro };
  };

  // ⚠️ Exactly the importer's call: no `responseOptionalFields`, so the
  // package's default list goes out (the test pins it against the importer).
  const d = await chamar(() =>
    e.client.getOrderDetail({ orderSnList: [e.orderSn], requestOrderStatusPending: true }),
  );
  const resumo = d.resposta === null ? null : resumoDoDetalhe(d.resposta.texto, e.orderSn);
  const detalheUtil =
    (d.erro === null || d.erro instanceof ShopeeSchemaError) && resumo?.linhaDaOrder === true;
  const gravacaoDoDetalhe =
    detalheUtil && d.resposta !== null ? e.gravar('detalhe', d.resposta.texto) : null;
  const detalhe: ChamadaDaCaptura = {
    papel: 'detalhe',
    ...d,
    gravacao: gravacaoDoDetalhe,
    salva: gravacaoDoDetalhe?.salvo === true,
  };

  if (!detalhe.salva) {
    return { detalhe, resumoDoDetalhe: resumo, escrow: null, linhasDeLogSuprimidas: contador.n };
  }

  const x = await chamar(() => e.client.getEscrowDetail({ orderSn: e.orderSn }));
  const gravacaoDoEscrow =
    escrowReproduzivel(x) && x.resposta !== null ? e.gravar('escrow', x.resposta.texto) : null;
  return {
    detalhe,
    resumoDoDetalhe: resumo,
    escrow: {
      papel: 'escrow',
      ...x,
      gravacao: gravacaoDoEscrow,
      salva: gravacaoDoEscrow?.salvo === true,
    },
    linhasDeLogSuprimidas: contador.n,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   errors                                    */
/* -------------------------------------------------------------------------- */

type MotivoDeParada = 'token' | 'assinatura' | 'ip-ou-permissao';

/**
 * The Shopee codes that mean STOP — compared through the package's ONE code
 * fold (`shopeeCodigoCanonico`: trim + one module segment), so
 * `common.error_auth` stops like `error_auth`. The spellings are the package's
 * and the app's own tables' (`anuncios/criacaoIncerta.ts`,
 * `nfe/classificarNfe.ts`), Shopee's `invalid_acceess_token` typo included.
 * The dead-grant codes need no row: the package builds them as
 * `ShopeeReauthRequiredError`, which {@link descreverErroCaptura} tests first.
 */
const CODIGOS_DE_PARADA: ReadonlyMap<string, MotivoDeParada> = new Map([
  ['error_auth', 'token'],
  ['invalid_acceess_token', 'token'],
  ['invalid_access_token', 'token'],
  ['error_sign', 'assinatura'],
  ['invalid_partner_id', 'assinatura'],
  ['error_partner_key_expired', 'assinatura'],
  ['source_ip_undeclared', 'ip-ou-permissao'],
  ['error_permission', 'ip-ou-permissao'],
  ['error_api_permission', 'ip-ou-permissao'],
  ['error_ashop_api_permission', 'ip-ou-permissao'],
  ['error_api_call_restricted', 'ip-ou-permissao'],
  ['api_suspended', 'ip-ou-permissao'],
  ['partner_shop_no_link', 'ip-ou-permissao'],
]);

const TEXTO_DA_PARADA: Readonly<Record<MotivoDeParada, string>> = {
  token: 'o token de acesso expirou ou não é desta loja.',
  assinatura:
    'a assinatura foi recusada: confira o relógio do PC (a Shopee recusa mais de 5 min de ' +
    'diferença) e redigite as quatro variáveis UMA vez; se repetir, pare.',
  'ip-ou-permissao': 'o app ao vivo restringe IPs ou não tem esta permissão.',
};

const LINHA_DE_PARADA =
  '   Não renove o token, não reconecte a loja e não mude nada no Console da Shopee. ' +
  'Mande só o código acima.';

function codigoImprimivel(codigo: string): string {
  return FORMA_CODIGO.test(codigo) ? codigo : '(formato inesperado)';
}

function nomeDaClasse(err: unknown): string {
  if (typeof err !== 'object' || err === null) return typeof err;
  const construtor = (err as { readonly constructor?: { readonly name?: unknown } }).constructor;
  return typeof construtor?.name === 'string' && construtor.name.length > 0
    ? construtor.name
    : 'Object';
}

/** A Node system error's `code` (`EEXIST`, `EACCES`), when it is token-shaped. */
function codigoDoSistema(err: unknown): string {
  const codigo = (err as { readonly code?: unknown } | null)?.code;
  return typeof codigo === 'string' && /^E[A-Z]{2,20}$/.test(codigo) ? ` (${codigo})` : '';
}

/**
 * One failure, described without a payload: a class, a token-shaped code, an
 * API path, an HTTP status, field PATHS — and what to do.
 *
 * ⚠️ Never `err.message` from the package's provider errors: it embeds
 * Shopee's own `message`, which can echo request data. The CLI's own errors are
 * printed whole, because every one of them is built from names and sentences.
 * The rate limit and the dead grant are tested BEFORE `ShopeeApiError`, which
 * both extend.
 */
export function descreverErroCaptura(err: unknown): string[] {
  if (err instanceof ArgumentoInvalidoError) {
    return [`❌ ${err.message}`, '', USO_CAPTURAR_PEDIDO];
  }
  if (
    err instanceof CredencialDaCapturaError ||
    err instanceof ArquivoRecusadoError ||
    err instanceof RequisicaoBloqueadaNaCapturaError
  ) {
    return [`❌ ${err.message}`];
  }
  if (err instanceof ShopeeRateLimitError) {
    return [
      `⏸ ShopeeRateLimitError (${err.kind}) code=${codigoImprimivel(err.code)} path=${err.path}`,
      err.kind === 'daily'
        ? '   Cota DIÁRIA esgotada: só depois de 00:00 UTC+8 (13:00 em Brasília). Nada foi renovado.'
        : '   Limite de chamadas: espere um minuto e capture de novo com OUTRO --nome. Nada foi renovado.',
    ];
  }
  if (err instanceof ShopeeReauthRequiredError) {
    return [
      `🛑 PARE: ${err.name} code=${codigoImprimivel(err.code)} path=${err.path} — a autorização da loja caiu.`,
      LINHA_DE_PARADA,
    ];
  }
  if (err instanceof ShopeeApiError) {
    const motivo = CODIGOS_DE_PARADA.get(shopeeCodigoCanonico(err.code));
    if (motivo !== undefined) {
      return [
        `🛑 PARE: ${err.name} code=${codigoImprimivel(err.code)} path=${err.path} — ${TEXTO_DA_PARADA[motivo]}`,
        LINHA_DE_PARADA,
      ];
    }
    return [
      `❌ ${err.name} (${err.kind}) code=${codigoImprimivel(err.code)} path=${err.path}`,
      '   A mensagem da Shopee não é impressa: ela pode repetir dados da requisição.',
    ];
  }
  if (err instanceof ShopeeHttpError) {
    // A 5xx without an envelope is usually the gateway hiccuping; anything else
    // is the shape of a rejection at Shopee's EDGE — the IP allow-list's.
    if (err.httpStatus >= 500) {
      return [
        `⚠️ ShopeeHttpError httpStatus=${String(err.httpStatus)} path=${err.path} — a borda da ` +
          'Shopee respondeu sem envelope. Capture de novo, UMA vez, com OUTRO --nome; se repetir, pare.',
      ];
    }
    return [
      `🛑 PARE: ShopeeHttpError httpStatus=${String(err.httpStatus)} path=${err.path} — a borda da ` +
        'Shopee respondeu sem envelope, a forma de uma recusa pela lista de IPs.',
      LINHA_DE_PARADA,
    ];
  }
  if (err instanceof ShopeeNetworkError) {
    if (err.cause instanceof RequisicaoBloqueadaNaCapturaError) {
      return [`❌ ShopeeNetworkError — a guarda de rede bloqueou: ${err.cause.alvo}`];
    }
    return [
      '❌ ShopeeNetworkError — falha de rede, sem resposta: nada desta chamada foi salvo. ' +
        'Confira a conexão e capture de novo com OUTRO --nome.',
    ];
  }
  if (err instanceof ShopeeSchemaError) {
    return [
      '⚠️ ShopeeSchemaError — o corpo não bate com o schema de wire (o mesmo da produção).',
      `   path=${err.path}`,
      `   campos: ${err.campos.length === 0 ? '(nenhum)' : err.campos.join(', ')}`,
    ];
  }
  if (err instanceof ShopeeConfigError) {
    // Its message can quote a received value (`recebido: …`) — never printed.
    return ['❌ ShopeeConfigError — o pacote recusou a configuração antes de qualquer chamada.'];
  }
  if (err instanceof ShopeeError) return [`❌ ${err.name}`];
  return [`❌ erro inesperado: ${nomeDaClasse(err)}${codigoDoSistema(err)}`];
}

/* -------------------------------------------------------------------------- */
/*                                 the report                                  */
/* -------------------------------------------------------------------------- */

function presente(v: boolean): string {
  return v ? 'presente' : 'AUSENTE';
}

/**
 * A path as a shell argument: verbatim when it holds only path characters,
 * else single-quoted with PowerShell's doubling of an inner quote (the runbook
 * is PowerShell, and a single-quoted string there expands nothing).
 */
export function argumentoDeShell(caminho: string): string {
  return /^[A-Za-z0-9_\-.:\\/]+$/.test(caminho) ? caminho : `'${caminho.replace(/'/g, "''")}'`;
}

function linhasDaChamada(c: ChamadaDaCaptura, arquivo: string): string[] {
  const linhas: string[] = [];
  if (c.resposta === null) {
    linhas.push('  resposta ............... nenhuma — a requisição não teve resposta');
  } else {
    linhas.push(
      `  caminho ................ ${c.resposta.path}`,
      `  HTTP ................... ${String(c.resposta.status)}`,
      `  error (envelope) ....... ${codigoDoEnvelope(c.resposta.texto)}`,
    );
  }
  linhas.push(...(c.erro === null ? [] : descreverErroCaptura(c.erro).map((l) => `  ${l}`)));
  const g = c.gravacao;
  if (c.salva) {
    linhas.push(`  arquivo ................ SALVO — ${arquivo}`);
  } else if (g !== null) {
    linhas.push(
      `  arquivo ................ NÃO salvo — a gravação falhou (${g.codigo ?? '?'}); nada ficou ` +
        'com o nome final',
    );
  } else {
    linhas.push('  arquivo ................ NÃO salvo');
    if (c.papel === 'escrow' && c.resposta !== null && falhaDeEscrowNaoContida(c.erro)) {
      linhas.push(
        '  (o importador NÃO contém esta falha do escrow: salvo, o arquivo faria a reprodução ' +
          'falhar. Para ter o par, capture de novo com OUTRO --nome quando a condição acima passar.)',
      );
    }
  }
  if (g?.parcialRestante != null) {
    linhas.push(
      `  ⚠️ sobrou o arquivo parcial ${g.parcialRestante} — tem dados do comprador: apague-o.`,
    );
  }
  return linhas;
}

export interface SaidaDaCaptura {
  readonly linhas: readonly string[];
  /** `0` when the detail body was saved — the escrow's outcome does not change it. */
  readonly codigo: 0 | 1;
}

/**
 * The report in pt-BR, in the sibling CLIs' dotted-label style — built BY NAME
 * from {@link ResultadoDaCaptura}: paths, statuses, token-shaped codes, counts,
 * closed-shape tokens, booleans and the two file paths. Never a body value.
 */
export function montarSaidaDaCaptura(
  r: ResultadoDaCaptura,
  caminhos: CaminhosDaCaptura,
): SaidaDaCaptura {
  const linhas: string[] = [
    `== capturar:pedido — loja BR de PRODUÇÃO (${HOST_DA_CAPTURA}), somente leitura ==`,
    '   Sem URL, token, chave, sign, shop_id ou valor de corpo nas linhas abaixo.',
    '',
    '## get_order_detail',
  ];
  const resumo = r.resumoDoDetalhe;
  if (resumo !== null) {
    linhas.push(
      `  linhas em order_list ... ${resumo.linhas === null ? '— (sem order_list)' : String(resumo.linhas)}`,
      `  a order pedida ......... ${resumo.linhaDaOrder ? 'veio' : 'NÃO veio — confira o order_sn e a loja'}`,
    );
    if (resumo.linha !== null) {
      const l = resumo.linha;
      linhas.push(
        `  região ................. ${l.regiao}`,
        `  order_status ........... ${l.orderStatus}`,
        `  recipient_address ...... ${presente(l.recipientAddress)}`,
        `  buyer_cpf_id ........... ${presente(l.buyerCpfId)}`,
        `  item_list .............. ${presente(l.itemList)}`,
      );
    }
  }
  linhas.push(...linhasDaChamada(r.detalhe, caminhos.detalhe), '', '## get_escrow_detail');
  if (r.escrow === null) {
    linhas.push('  não chamado — o detalhe não foi salvo, e nada mais foi pedido à Shopee');
  } else {
    linhas.push(...linhasDaChamada(r.escrow, caminhos.escrow));
  }
  if (r.linhasDeLogSuprimidas > 0) {
    linhas.push(
      '',
      `  linhas de log do pacote suprimidas: ${String(r.linhasDeLogSuprimidas)} (podem citar o corpo; nunca impressas)`,
    );
  }

  linhas.push('');
  if (!r.detalhe.salva) {
    linhas.push('## Resultado', '  ❌ nada foi salvo para a reprodução (código 1).');
    const g = r.detalhe.gravacao;
    if (g !== null && g.parcialRestante === null) {
      linhas.push(
        g.codigo === 'EEXIST'
          ? '  Um arquivo com esse nome apareceu durante a captura e não foi tocado: use OUTRO --nome.'
          : '  A Shopee respondeu, mas a gravação falhou (disco cheio? pasta de rede?). Nenhum ' +
              'arquivo ficou: resolva e rode de novo — o mesmo --nome serve.',
      );
    }
    return { linhas, codigo: 1 };
  }
  const comEscrow = r.escrow?.salva === true;
  linhas.push(
    '## Próximo passo',
    `  pnpm --filter @delfrance/shopee-app reproduzir:pedido --detalhe ${argumentoDeShell(caminhos.detalhe)}` +
      (comEscrow ? ` --escrow ${argumentoDeShell(caminhos.escrow)}` : ''),
  );
  if (!comEscrow) {
    linhas.push(
      '  (sem --escrow: o escrow não foi salvo, e o importador cai nos preços do detalhe)',
    );
  }
  linhas.push(
    '  ⚠️ Os arquivos têm os dados REAIS do comprador: não cole, não envie, não commite — e apague-os',
    '     depois da reprodução. Cole aqui só o relatório (stdout) do reproduzir:pedido.',
  );
  return { linhas, codigo: 0 };
}
