/**
 * The pure half of `scripts/reproduzir-pedido.ts` — argument parsing, the path
 * and network guards, the REDACTED summary, its renderer, the residue scan and
 * the error describer.
 *
 * ⚠️ **It lives here rather than in the script because `scripts/` is outside
 * this app's vitest `include`**, so a decision written in the script could
 * never be tested — the `importarPedidoCli.ts` precedent, which this module
 * reuses rather than copies (its argument error class and its two pedido and
 * pagamento allow-lists). Nothing here reads the environment, a file, a clock
 * or a Firestore; the guards take their filesystem probe as a parameter.
 *
 * ## The two guarantees, and which layer holds each
 *
 * The replay reads REAL production buyer data, and its stdout is pasted into a
 * chat. So nothing printed may carry a buyer value, and two independent layers
 * hold that:
 *
 *  1. **The summary is an ALLOW-LIST** ({@link resumoDaReproducao}). Every field
 *     is built by name from a verdict, a count, a closed-set token or an id;
 *     no document is spread and no captured value is copied. A field that is
 *     not listed cannot appear — including whatever a future schema adds.
 *  2. **The RESIDUE SCAN** ({@link encontrarResiduos}) runs over the rendered
 *     lines AND over every recorded console line, looking for the capture's own
 *     buyer values ({@link valoresSensiveisDaCaptura}). A hit in the report
 *     prints NOTHING of it — only a refusal naming the FIELDS that leaked; a hit
 *     in a log line suppresses that line. The scan is the backstop for layer 1,
 *     never a substitute: it matches whole values, so a partial leak (one word
 *     of a name) is layer 1's to prevent.
 *
 * ⚠️ The `order_sn` is not buyer data, but the report reduces it to a prefix
 * and its length, so every printed line has it replaced by `«order_sn»` — the
 * pedido and pagamento summaries carry it as `numero` and `id`. The endereço's
 * document id IS derived from buyer data (an unsalted sha1 of the address), so
 * every printed line has it replaced by `«endereco_id»` too.
 *
 * ⚠️ `--saida` is the one place values ARE written: a JSON file of the
 * read-back documents, outside every checkout, never overwritten. The script
 * says so on stderr when it writes one.
 */
import nodePath from 'node:path';
import { normalizeDocumento } from '@delfrance/core/documents';
import {
  ENDERECO_FALLBACKS,
  MOTIVO_RECUSA,
  TIPO_DE_VALOR,
  motivoDaRecusa,
  toDocPathOrNull,
  ufSchema,
  valorUtilizavel,
  type EnderecoBuildOutcome,
  type MotivoRecusa,
} from '@delfrance/schemas';
import {
  SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS,
  ShopeeApiError,
  ShopeeError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeSchemaError,
  shopeeOrderDetailRowSchema,
} from '@delfrance/integrations-shopee';
import { ZodError } from 'zod';

import { enderecoDeShopee, portoesDoEnderecoShopee } from './comprador';
import {
  ArgumentoInvalidoError,
  renderResumoPedido,
  resumoDoPedidoArmazenado,
  resumoDosPagamentosArmazenados,
  type PagamentoResumoShopee,
  type ResumoPedidoShopee,
} from './importarPedidoCli';
// Types only — erased, so `--help` loads none of the importer's graph.
import type {
  ContagemDeClientes,
  DocumentoLido,
  EscrowCapturado,
  LeituraReproducao,
  ResultadoReproducao,
} from './reproduzirPedido';

export { ArgumentoInvalidoError } from './importarPedidoCli';

/* -------------------------------------------------------------------------- */
/*                                    errors                                   */
/* -------------------------------------------------------------------------- */

/**
 * A capture file the replay cannot use — not JSON, not an envelope, no order,
 * a detail/escrow pair of two different orders. ⚠️ Value-free by construction:
 * every message is built from KEY NAMES, counts and our own sentences.
 */
export class CapturaInvalidaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapturaInvalidaError';
  }
}

/** A path the replay refuses to read or write — inside a checkout, missing, or already there. */
export class ArquivoRecusadoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArquivoRecusadoError';
  }
}

/** The replayed client asked for a path nobody captured. Carries the PATH only. */
export class ChamadaNaoCapturadaError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`a reprodução não tem captura para ${path}`);
    this.name = 'ChamadaNaoCapturadaError';
    this.path = path;
  }
}

/** The escrow call, refused because no `--escrow` was given — a network failure by shape. */
export class EscrowNaoCapturadoError extends Error {
  constructor() {
    super('sem --escrow: a reprodução recusa o get_escrow_detail como uma falha de rede');
    this.name = 'EscrowNaoCapturadoError';
  }
}

/** The script's network guard refused a request. Carries the HOST only — a URL can carry a token. */
export class ChamadaDeRedeBloqueadaError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`a reprodução bloqueou uma chamada de rede para ${host}`);
    this.name = 'ChamadaDeRedeBloqueadaError';
    this.host = host;
  }
}

/* -------------------------------------------------------------------------- */
/*                                  arguments                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ No `--` separator in the documented invocation: pnpm forwards that token
 * into the script (`packages/config-eslint/rules/pnpm-run-args.test.js`).
 */
export const USO_REPRODUZIR_PEDIDO = `
Reproduz uma order REAL da Shopee, a partir de capturas, pelo importador de
verdade do step 5 — offline: nenhuma chamada à Shopee, Firestore em memória.

  pnpm --filter @delfrance/shopee-app reproduzir:pedido \\
    --detalhe <arquivo> [--escrow <arquivo>] [opções]

Obrigatório
  --detalhe <arquivo>  o corpo CRU da resposta do get_order_detail, salvo FORA
                       de qualquer checkout

Opções
  --escrow <arquivo>   o corpo CRU da resposta do get_escrow_detail da MESMA
                       order. Sem ele, o escrow falha como falha de rede e o
                       pedido importa com os preços do detalhe.
  --order-sn <sn>      escolhe a order quando a captura do detalhe traz várias
  --viacep             usa o ViaCEP de verdade quando a UF não mapeia (o CEP
                       sai da máquina SÓ nesse caso). Sem a flag, um stub
                       responde "não sei" e nada sai.
  --saida <arquivo>    grava os documentos relidos, COM os valores do
                       comprador, num JSON novo FORA de qualquer checkout
                       (nunca sobrescreve). Não cole nem commite esse arquivo.
  --help, -h           mostra esta ajuda e sai com 0

Todo <arquivo> é um caminho ABSOLUTO: o pnpm roda o script dentro de
apps/shopee, então um caminho relativo é recusado.

O relatório no stdout é redigido: nenhum valor do comprador, e uma varredura
recusa o relatório inteiro se algum aparecer. Ver apps/shopee/scripts/README.md.
`.trim();

export interface ArgsReproduzirPedido {
  readonly detalhe: string;
  readonly escrow: string | null;
  readonly orderSn: string | null;
  readonly viaCep: boolean;
  readonly saida: string | null;
}

export type ComandoReproduzirPedido =
  | { readonly kind: 'ajuda' }
  | { readonly kind: 'reproduzir'; readonly args: ArgsReproduzirPedido };

/** What an unknown token must look like for the refusal to NAME it. */
const FORMA_DE_FLAG = /^--?[a-z][a-z-]*$/i;

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
 * ⚠️ Flags are matched EXACTLY: `--viaCep` is not `--viacep`, and none of the
 * `importar:pedido` buyer-mode flags exist here — this replay feeds the
 * importer the real buyer, never a substitute. Each value flag may appear once.
 */
export function parseArgsReproduzirPedido(argv: readonly string[]): ComandoReproduzirPedido {
  if (argv.some((a) => a === '--help' || a === '-h')) return { kind: 'ajuda' };

  const valores = new Map<string, string>();
  let viaCep = false;

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
      case '--detalhe':
      case '--escrow':
      case '--order-sn':
      case '--saida': {
        if (valores.has(nome)) throw new ArgumentoInvalidoError(`${nome} informado duas vezes.`);
        valores.set(nome, valorDe(nome, inline, argv[i + 1]));
        if (inline === undefined) i += 1;
        break;
      }
      case '--viacep':
        if (inline !== undefined) throw new ArgumentoInvalidoError('--viacep não aceita valor.');
        viaCep = true;
        break;
      default:
        // ⚠️ Never echo a VALUE: a path or an order_sn typed without its flag
        // would otherwise land in the error line.
        throw new ArgumentoInvalidoError(
          FORMA_DE_FLAG.test(nome)
            ? `Opção desconhecida: ${nome}${inline === undefined ? '' : '=…'}`
            : 'Argumento solto, sem flag (o valor não é repetido aqui): passe cada valor logo ' +
                'depois da sua flag (veja --help).',
        );
    }
  }

  const detalhe = valores.get('--detalhe');
  if (detalhe === undefined) throw new ArgumentoInvalidoError('--detalhe <arquivo> é obrigatório.');
  return {
    kind: 'reproduzir',
    args: {
      detalhe,
      escrow: valores.get('--escrow') ?? null,
      orderSn: valores.get('--order-sn') ?? null,
      viaCep,
      saida: valores.get('--saida') ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                              the path guards                                */
/* -------------------------------------------------------------------------- */

export type PapelDoArquivo = '--detalhe' | '--escrow' | '--saida';

/** The entries that make a directory a checkout: a worktree has a `.git` FILE, a clone a folder. */
const MARCADORES_DE_CHECKOUT = ['.git', 'pnpm-workspace.yaml'] as const;

type Caminhos = Pick<typeof nodePath, 'resolve' | 'dirname' | 'join' | 'isAbsolute' | 'relative'>;

export interface DepsDoCaminho {
  /** The filesystem probe — `existsSync` in the script, a set in the tests. */
  readonly existe: (caminho: string) => boolean;
  /**
   * Resolves links and junctions — `realpathSync.native` in the script, a map
   * in the tests. Absent: only the path as given is walked.
   */
  readonly realpath?: (caminho: string) => string;
  /** Defaults to the running platform's `node:path`; a test passes `path.win32` or `path.posix`. */
  readonly caminhos?: Caminhos;
}

/** The nearest ancestor of `dir` (itself included) holding a checkout marker, or `null`. */
function raizDeCheckout(p: Caminhos, dir0: string, existe: (c: string) => boolean): string | null {
  let dir = dir0;
  for (;;) {
    if (MARCADORES_DE_CHECKOUT.some((m) => existe(p.join(dir, m)))) return dir;
    const pai = p.dirname(dir);
    if (pai === dir) return null;
    dir = pai;
  }
}

/**
 * `absoluto` with its deepest EXISTING ancestor resolved through `realpath`
 * (the rest is a tail that does not exist yet — a `--saida` file, say).
 */
function caminhoReal(
  p: Caminhos,
  absoluto: string,
  existe: (c: string) => boolean,
  realpath: (c: string) => string,
): string {
  let existente = absoluto;
  while (!existe(existente)) {
    const pai = p.dirname(existente);
    if (pai === existente) break;
    existente = pai;
  }
  return p.join(realpath(existente), p.relative(existente, absoluto));
}

/**
 * Refuse a path that sits inside ANY checkout, and return it resolved.
 *
 * It walks every ancestor of the resolved path — the path itself first — and
 * asks the filesystem whether that directory holds a checkout marker. There is
 * deliberately NO string comparison between paths: `C:\x\next_erp-capturas` is
 * not inside `C:\x\next_erp` because its ancestors are `C:\x` and `C:\`, never
 * because a prefix test happened to be written right. Drive-letter case and
 * trailing separators are the resolver's and the filesystem's (NTFS answers a
 * probe case-insensitively), never this function's.
 *
 * ⚠️ The walk runs TWICE when `deps.realpath` is given: over the path as typed
 * AND over its real location, so a junction or symlink from outside INTO a
 * checkout is refused like the checkout path itself.
 *
 * ⚠️ A RELATIVE path is refused, not resolved: `pnpm --filter` runs the script
 * with `apps/shopee` as its working directory, so a path relative to the shell
 * the user typed it in would silently point somewhere else.
 */
export function exigirForaDeCheckout(
  papel: PapelDoArquivo,
  caminho: string,
  deps: DepsDoCaminho,
): string {
  const p = deps.caminhos ?? nodePath;
  if (!p.isAbsolute(caminho)) {
    throw new ArquivoRecusadoError(
      `${papel} precisa de um caminho ABSOLUTO: o pnpm roda o script dentro de apps/shopee, ` +
        'então um caminho relativo apontaria para outro lugar.',
    );
  }
  const absoluto = p.resolve(caminho);
  const cadeias: { readonly dir: string; readonly viaLink: boolean }[] = [
    { dir: absoluto, viaLink: false },
  ];
  if (deps.realpath !== undefined) {
    const real = caminhoReal(p, absoluto, deps.existe, deps.realpath);
    if (real !== absoluto) cadeias.push({ dir: real, viaLink: true });
  }
  for (const { dir, viaLink } of cadeias) {
    const raiz = raizDeCheckout(p, dir, deps.existe);
    if (raiz === null) continue;
    throw new ArquivoRecusadoError(
      `${papel} aponta para dentro de um checkout (${raiz})${viaLink ? ', através de um link ou junção' : ''}. ` +
        'As capturas brutas e o arquivo de --saida (com os valores completos do comprador) têm ' +
        'de ficar FORA de qualquer checkout — numa pasta que nenhum git add alcança.',
    );
  }
  return absoluto;
}

/** A capture that is not there. Names the ROLE only: a file name can carry an order_sn. */
export function exigirArquivoExistente(
  papel: '--detalhe' | '--escrow',
  absoluto: string,
  existe: (caminho: string) => boolean,
): void {
  if (!existe(absoluto)) throw new ArquivoRecusadoError(`${papel}: arquivo não encontrado.`);
}

/** `--saida` never overwrites — the script also writes with `flag: 'wx'`. */
export function exigirSaidaNova(absoluto: string, existe: (caminho: string) => boolean): void {
  if (existe(absoluto)) {
    throw new ArquivoRecusadoError(
      '--saida já existe; a reprodução nunca sobrescreve. Use outro nome.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                              the network guard                              */
/* -------------------------------------------------------------------------- */

/** The ONE host the replay may reach, and only under `--viacep`. */
export const HOST_VIACEP = 'viacep.com.br';

/** The URL string of any `fetch` input. */
export function urlDaRequisicao(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Whether the script's `fetch` guard lets this request leave the machine:
 * ONLY `https://viacep.com.br` on its default port, with no credentials in the
 * URL, and only when `--viacep` was given. Everything else is refused — a
 * look-alike host, plain `http`, a userinfo trick, an unparseable URL.
 */
export function hostPermitidoNaReproducao(url: string, viaCepLigado: boolean): boolean {
  if (!viaCepLigado) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch (err) {
    if (err instanceof TypeError) return false;
    throw err;
  }
  return (
    u.protocol === 'https:' &&
    u.hostname === HOST_VIACEP &&
    u.port === '' &&
    u.username === '' &&
    u.password === ''
  );
}

/** The host of a refused URL, for the stderr line — never the URL itself. */
export function hostParaRelatorio(url: string): string {
  try {
    return new URL(url).hostname || '(sem host)';
  } catch (err) {
    if (err instanceof TypeError) return '(url ilegível)';
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*                                   ViaCEP                                    */
/* -------------------------------------------------------------------------- */

/**
 * The default ViaCEP: answers "unknown" to every CEP, so an `uf-desconhecida`
 * endereço keeps the builder's `AC` exactly as a ViaCEP outage would leave it —
 * and nothing leaves the machine. The engine counts the consultations.
 */
export function viaCepDesligado(): { buscarCep: (cep: string) => Promise<null> } {
  return { buscarCep: () => Promise.resolve(null) };
}

/* -------------------------------------------------------------------------- */
/*                              the redacted summary                           */
/* -------------------------------------------------------------------------- */

export interface ResumoDoResultado {
  readonly acao: string;
  readonly detail: string;
  readonly orderStatus: string | null;
  readonly acaoPagamentos: string | null;
  readonly pagamentosGravados: number;
  readonly acaoFrete: string | null;
  readonly itensSemProduto: number;
}

export type SituacaoDoValor = 'ausente' | 'mascarado' | 'invalido' | 'utilizavel';

export interface ResumoDoDocumento {
  readonly situacao: SituacaoDoValor;
  /** The canonical length when it is a CPF's or a CNPJ's (11 / 14); `'outro'` otherwise. */
  readonly comprimento: 11 | 14 | 'outro' | null;
  /** The shared predicate's check-digit verdict, when the length is 11 or 14. */
  readonly digitosVerificadoresValidos: boolean | null;
  readonly tipo: 'PF' | 'PJ' | null;
}

export interface ResumoDoCliente {
  readonly vinculado: boolean;
  readonly id: string | null;
  /** The in-memory database starts with no cliente, so a linked one was created by this run. */
  readonly criado: boolean | null;
  /** Field NAMES with a non-empty value — never a value. */
  readonly camposPreenchidos: readonly string[];
}

export type ResultadoDoConstrutor = EnderecoBuildOutcome['kind'] | 'nao-construido';

export interface ResumoDoEndereco {
  /** `enderecoDeShopee` over the RAW captured row. */
  readonly construtor: ResultadoDoConstrutor;
  /** The three gates' refusals (`nome:`, `logradouro:`, `cep:` + a verdict), or why none ran. */
  readonly portoesRecusados: readonly string[];
  /** The captured zipcode's DIGIT count — never the digits. */
  readonly digitosDoCep: number | null;
  /**
   * ⚠️ No id: the endereço's document id is legacy `makeEnderecoId`, an UNSALTED
   * sha1 over the buyer's address parts — one guess away from confirming an
   * address, and the id of the real document in the production corpus. Every
   * printed line carries it as {@link ENDERECO_ID_REDIGIDO}.
   */
  readonly vinculado: boolean;
  /** The stored UF, when it is in `ufSchema`'s closed set; `'(inválida)'` otherwise. */
  readonly uf: string | null;
  /** The stored `pais`: `null` means BR. */
  readonly pais: string | null;
  readonly codigoMunicipioPreenchido: boolean | null;
  readonly camposPreenchidos: readonly string[];
  /** Fields holding a builder fallback, as `campo=LITERAL` — the literal is the builder's own. */
  readonly fallbacks: readonly string[];
}

export interface ResumoReproducao {
  readonly captura: {
    readonly regiao: string;
    readonly orderStatus: string;
    readonly moeda: string;
    readonly orderSnPrefixo: string;
    readonly orderSnComprimento: number;
    readonly linhasDeItem: number | null;
    readonly escrow: EscrowCapturado;
    /** `SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS` tokens whose response key is ABSENT from the row. */
    readonly camposOpcionaisAusentes: readonly string[];
    /** Which of the `edt` token's three candidate keys arrived — NAMES only (settle-live). */
    readonly chavesDoEdt: readonly string[];
    /** `recipient_address`, `buyer_cpf_id` or `item_list` absent: the capture must be redone. */
    readonly capturaIncompleta: boolean;
  };
  readonly chamadas: {
    readonly detalheServidas: number;
    readonly escrowServidas: number;
    readonly escrowRecusadas: number;
    readonly inesperadas: readonly string[];
  };
  readonly primeira: ResumoDoResultado;
  readonly comprador: {
    readonly captura: {
      readonly estado: string | null;
      readonly camposRecusados: readonly string[];
      /**
       * DERIVED: the `endereco:`-prefixed entries of `camposRecusados` — the only
       * extras the importer adds. The mapper's own `camposRecusadosExtra` is
       * never stored (`orderPedidoTx.ts` names the diary field by field).
       */
      readonly camposRecusadosDeEndereco: readonly string[];
    };
    readonly documento: ResumoDoDocumento;
    readonly nome: SituacaoDoValor;
  };
  readonly cliente: ResumoDoCliente;
  readonly endereco: ResumoDoEndereco;
  readonly pedido: ResumoPedidoShopee | null;
  readonly pagamentos: readonly PagamentoResumoShopee[];
  readonly incidentes: number;
  readonly viaCep: { readonly modo: 'stub' | 'real'; readonly consultas: number };
  readonly segunda: ResumoDoResultado & {
    readonly documentosAlterados: readonly string[];
    readonly clientesAntes: string;
    readonly clientesDepois: string;
  };
  readonly logsGravados: number;
}

/* ------------------------------ raw readers ------------------------------- */

function objeto(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** A value shown only when it matches a closed TOKEN shape — never free text. */
function token(v: unknown, forma: RegExp): string {
  if (v === undefined || v === null || v === '') return '(ausente)';
  return typeof v === 'string' && forma.test(v) ? v : '(formato inesperado)';
}

const FORMA_REGIAO = /^[A-Z]{2}$/;
const FORMA_STATUS = /^[A-Z_]{1,40}$/;
const FORMA_MOEDA = /^[A-Z]{3}$/;
const UFS = new Set<string>(ufSchema.options);

/**
 * The response keys each optional token may produce. Every token is its own
 * key except `edt`: the samples answer `edt_from` / `edt_to`, while the wire
 * schema also declares an `edt` key of unknown shape so the FIRST real reader
 * settles what the token produces (`types.ts`) — so it is absent only when NONE
 * of the three arrived, and {@link chavesDoEdt} reports which did.
 */
const CHAVES_DO_EDT = ['edt', 'edt_from', 'edt_to'] as const;
const CHAVES_DO_TOKEN: Readonly<Record<string, readonly string[]>> = {
  edt: CHAVES_DO_EDT,
};

/** Without these three the replay cannot judge the buyer or the items at all. */
const TOKENS_ESSENCIAIS = ['recipient_address', 'buyer_cpf_id', 'item_list'] as const;

export function camposOpcionaisAusentes(linha: Readonly<Record<string, unknown>>): string[] {
  return SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS.split(',').filter(
    (t) => !(CHAVES_DO_TOKEN[t] ?? [t]).some((chave) => Object.hasOwn(linha, chave)),
  );
}

/** Which of `edt`'s candidate keys the row carries — key NAMES, never a value. */
export function chavesDoEdt(linha: Readonly<Record<string, unknown>>): string[] {
  return CHAVES_DO_EDT.filter((chave) => Object.hasOwn(linha, chave));
}

function situacao(motivo: MotivoRecusa | null): SituacaoDoValor {
  if (motivo === null) return 'utilizavel';
  switch (motivo) {
    case MOTIVO_RECUSA.ausente:
      return 'ausente';
    case MOTIVO_RECUSA.mascarado:
      return 'mascarado';
    case MOTIVO_RECUSA.invalido:
      return 'invalido';
  }
}

/** The buyer document as Shopee sent it — verdicts and a closed-set length, never the digits. */
export function resumoDoDocumento(bruto: unknown): ResumoDoDocumento {
  const estado = situacao(motivoDaRecusa(bruto, TIPO_DE_VALOR.documento));
  const valor = valorUtilizavel(bruto);
  if (valor === null) {
    return { situacao: estado, comprimento: null, digitosVerificadoresValidos: null, tipo: null };
  }
  const comprimento = normalizeDocumento(valor).length;
  if (comprimento !== 11 && comprimento !== 14) {
    return {
      situacao: estado,
      comprimento: 'outro',
      digitosVerificadoresValidos: null,
      tipo: null,
    };
  }
  return {
    situacao: estado,
    comprimento,
    // The shared predicate (`cpfCnpjUtilizavel` behind `motivoDaRecusa`): at
    // this length the only remaining refusal is the check digits.
    digitosVerificadoresValidos: estado === 'utilizavel',
    tipo: comprimento === 11 ? 'PF' : 'PJ',
  };
}

/** Field NAMES whose value is non-empty — never a value. */
export function camposPreenchidos(dados: Readonly<Record<string, unknown>> | null): string[] {
  if (dados === null) return [];
  return Object.entries(dados)
    .filter(([, v]) => {
      if (v === null || v === undefined || v === '') return false;
      if (Array.isArray(v)) return v.length > 0;
      const o = objeto(v);
      return o === null || Object.keys(o).length > 0;
    })
    .map(([k]) => k)
    .sort();
}

function resumoDoResultado(r: ResultadoReproducao['primeira']): ResumoDoResultado {
  return {
    acao: r.acao,
    detail: r.detail,
    orderStatus: r.orderStatus,
    acaoPagamentos: r.acaoPagamentos,
    pagamentosGravados: r.pagamentosGravados,
    acaoFrete: r.acaoFrete,
    itensSemProduto: r.itensSemProduto,
  };
}

function contagem(c: ContagemDeClientes): string {
  return c.truncado ? `${String(c.ids.length)}+` : String(c.ids.length);
}

function resumoDoEndereco(
  linhaBruta: Readonly<Record<string, unknown>>,
  endereco: DocumentoLido | null,
): ResumoDoEndereco {
  // The SAME wire schema the client parsed with — so the builder sees exactly
  // the row the importer saw.
  const linha = shopeeOrderDetailRowSchema.safeParse(linhaBruta);
  let construtor: ResultadoDoConstrutor = 'nao-construido';
  let portoesRecusados: string[] = ['linha:schema'];
  let digitosDoCep: number | null = null;
  if (linha.success) {
    const addr = linha.data.recipient_address;
    if (addr == null) {
      portoesRecusados = ['endereco:ausente'];
    } else {
      portoesRecusados = [...portoesDoEnderecoShopee(addr, linha.data.region).recusados];
      const saida = enderecoDeShopee(addr, linha.data.region);
      construtor = saida === null ? 'nao-construido' : saida.kind;
      const cep = valorUtilizavel(addr.zipcode);
      digitosDoCep = cep === null ? null : (cep.match(/\d/g)?.length ?? 0);
    }
  }
  const dados = endereco?.dados ?? null;
  const estado = dados?.estado;
  const pais = dados?.pais;
  return {
    construtor,
    portoesRecusados,
    digitosDoCep,
    vinculado: endereco !== null,
    uf:
      dados === null || estado === null || estado === undefined
        ? null
        : typeof estado === 'string' && UFS.has(estado)
          ? estado
          : '(inválida)',
    pais:
      dados === null || pais === null || pais === undefined
        ? null
        : typeof pais === 'string' && FORMA_REGIAO.test(pais)
          ? pais
          : '(inválido)',
    codigoMunicipioPreenchido:
      dados === null
        ? null
        : typeof dados.codigoMunicipio === 'string' && dados.codigoMunicipio.length > 0,
    camposPreenchidos: camposPreenchidos(dados),
    fallbacks:
      dados === null
        ? []
        : (Object.keys(ENDERECO_FALLBACKS) as (keyof typeof ENDERECO_FALLBACKS)[])
            .filter((c) => dados[c] === ENDERECO_FALLBACKS[c])
            .map((c) => `${c}=${ENDERECO_FALLBACKS[c]}`),
  };
}

/**
 * The whole report, as DATA, built field by field — see the module header.
 * Nothing here copies a captured or a stored value that is not a verdict, a
 * count, a closed-set token or an id.
 */
export function resumoDaReproducao(
  r: ResultadoReproducao,
  opcoes: { readonly viaCepLigado: boolean },
): ResumoReproducao {
  const linha = r.linhaBruta;
  const ausentes = camposOpcionaisAusentes(linha);
  const itens = linha.item_list;
  const destinatario = objeto(linha.recipient_address);
  const pedido = r.leitura.pedido;
  const captura = objeto(pedido?.dados.capturaComprador);
  const textos = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const camposRecusados = textos(captura?.camposRecusados);

  return {
    captura: {
      regiao: token(linha.region, FORMA_REGIAO),
      orderStatus: token(linha.order_status, FORMA_STATUS),
      moeda: token(linha.currency, FORMA_MOEDA),
      orderSnPrefixo: r.orderSn.slice(0, 6),
      orderSnComprimento: r.orderSn.length,
      linhasDeItem: Array.isArray(itens) ? itens.length : null,
      escrow: r.escrowCapturado,
      camposOpcionaisAusentes: ausentes,
      chavesDoEdt: chavesDoEdt(linha),
      capturaIncompleta: TOKENS_ESSENCIAIS.some((t) => ausentes.includes(t)),
    },
    chamadas: {
      detalheServidas: r.chamadas.filter((c) => c.servido && c.path.endsWith('/get_order_detail'))
        .length,
      escrowServidas: r.chamadas.filter((c) => c.servido && c.path.endsWith('/get_escrow_detail'))
        .length,
      escrowRecusadas: r.chamadas.filter((c) => !c.servido && c.path.endsWith('/get_escrow_detail'))
        .length,
      inesperadas: [
        ...new Set(
          r.chamadas
            .filter(
              (c) =>
                !c.path.endsWith('/get_order_detail') && !c.path.endsWith('/get_escrow_detail'),
            )
            .map((c) => c.path),
        ),
      ],
    },
    primeira: resumoDoResultado(r.primeira),
    comprador: {
      captura: {
        estado: typeof captura?.estado === 'string' ? captura.estado : null,
        camposRecusados,
        camposRecusadosDeEndereco: camposRecusados.filter((c) => c.startsWith('endereco:')),
      },
      documento: resumoDoDocumento(linha.buyer_cpf_id),
      nome: situacao(motivoDaRecusa(destinatario?.name, TIPO_DE_VALOR.nome)),
    },
    cliente: {
      vinculado: r.leitura.cliente !== null,
      id: r.leitura.cliente?.id ?? null,
      criado:
        r.leitura.cliente === null ? null : !r.clientesAntes.ids.includes(r.leitura.cliente.id),
      camposPreenchidos: camposPreenchidos(r.leitura.cliente?.dados ?? null),
    },
    endereco: resumoDoEndereco(linha, r.leitura.endereco),
    pedido: pedido === null ? null : resumoDoPedidoArmazenado(pedido.id, pedido.dados),
    pagamentos: resumoDosPagamentosArmazenados(
      r.leitura.pagamentos.map((d) => ({ id: d.id, data: d.dados })),
    ),
    incidentes: r.leitura.incidentes.length,
    viaCep: { modo: opcoes.viaCepLigado ? 'real' : 'stub', consultas: r.consultasViaCep },
    segunda: {
      ...resumoDoResultado(r.segunda),
      documentosAlterados: [...r.documentosAlterados],
      clientesAntes: contagem(r.clientesAntes),
      clientesDepois: contagem(r.leituraFinal.clientes),
    },
    logsGravados: r.logs.length,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  rendering                                  */
/* -------------------------------------------------------------------------- */

function lista(v: readonly string[]): string {
  return v.length === 0 ? '(nenhum)' : v.join(', ');
}

function simNao(v: boolean): string {
  return v ? 'sim' : 'não';
}

const TEXTO_SITUACAO: Readonly<Record<SituacaoDoValor, string>> = {
  ausente: 'ausente',
  mascarado: 'MASCARADO',
  invalido: 'inválido',
  utilizavel: 'utilizável',
};

const TEXTO_ESCROW: Readonly<Record<EscrowCapturado, string>> = {
  ausente: 'AUSENTE — sem --escrow; o importador cai nos preços do detalhe',
  resposta: 'presente',
  erro: 'envelope de ERRO da Shopee — o importador cai nos preços do detalhe',
};

function textoDoDocumento(d: ResumoDoDocumento): string {
  if (d.comprimento === null) return TEXTO_SITUACAO[d.situacao];
  if (d.comprimento === 'outro') {
    return `${TEXTO_SITUACAO[d.situacao]} — comprimento fora de 11/14`;
  }
  const dv = d.digitosVerificadoresValidos === true ? 'DV válidos' : 'DV INVÁLIDOS';
  return `${TEXTO_SITUACAO[d.situacao]} — ${String(d.comprimento)} dígitos, ${dv}, ${d.tipo === 'PF' ? 'PF (CPF)' : 'PJ (CNPJ)'}`;
}

function linhasDoResultado(r: ResumoDoResultado): string[] {
  return [
    `  resultado ............... ${r.acao}   (${r.detail})`,
    `  order_status ............ ${r.orderStatus ?? '—'}`,
    `  pagamentos .............. ${r.acaoPagamentos ?? '(não rodou)'}   gravados=${String(r.pagamentosGravados)}`,
    `  frete (step 7) .......... ${r.acaoFrete ?? '(não rodou)'}`,
    `  linhas sem produto ...... ${String(r.itensSemProduto)}`,
  ];
}

/** The report in pt-BR, in the sibling CLI's dotted-label style. */
export function renderReproducao(r: ResumoReproducao): string[] {
  const c = r.captura;
  const linhas: string[] = [
    r.viaCep.modo === 'real'
      ? '== REPRODUÇÃO LOCAL — nenhuma chamada à Shopee, Firestore em memória; só o CEP vai ao ViaCEP (--viacep) =='
      : '== REPRODUÇÃO LOCAL — nenhuma chamada à Shopee, Firestore em memória, nada sai da máquina ==',
    '   Relatório redigido: nenhum valor do comprador aparece abaixo, só vereditos, contagens e ids.',
    '',
    '## A captura',
    `  região .................. ${c.regiao}`,
    `  order_status ............ ${c.orderStatus}`,
    `  moeda ................... ${c.moeda}`,
    `  order_sn ................ ${c.orderSnPrefixo}… (${String(c.orderSnComprimento)} caracteres)`,
    `  linhas de item .......... ${c.linhasDeItem === null ? '— (item_list ausente)' : String(c.linhasDeItem)}`,
    `  escrow .................. ${TEXTO_ESCROW[c.escrow]}`,
    `  campos opcionais ausentes ${lista(c.camposOpcionaisAusentes)}`,
    `  edt — chaves que vieram . ${lista(c.chavesDoEdt)}   (o token pede edt; a amostra traz edt_from/edt_to)`,
  ];
  if (c.capturaIncompleta) {
    linhas.push(
      '  ⚠️⚠️ A CAPTURA FOI FEITA SEM O response_optional_fields DO IMPORTADOR — refaça-a.',
      '     Sem recipient_address / buyer_cpf_id / item_list a Shopee nem manda o campo, e o',
      '     veredito abaixo descreveria a captura, não a order. Ver scripts/README.md.',
    );
  }

  linhas.push(
    '',
    '## O que a reprodução serviu',
    `  get_order_detail ........ ${String(r.chamadas.detalheServidas)} (uma por passada)`,
    `  get_escrow_detail ....... servidas=${String(r.chamadas.escrowServidas)} recusadas=${String(r.chamadas.escrowRecusadas)}`,
    `  caminhos inesperados .... ${lista(r.chamadas.inesperadas)}`,
    '',
    '## 1ª passada — a importação',
    ...linhasDoResultado(r.primeira),
  );

  const doc = r.comprador.documento;
  linhas.push(
    '',
    '## Comprador',
    `  capturaComprador ........ ${r.comprador.captura.estado ?? '—'}`,
    `    camposRecusados ....... ${lista(r.comprador.captura.camposRecusados)}`,
    `    dos quais de endereço . ${lista(r.comprador.captura.camposRecusadosDeEndereco)}   (derivado: os endereco:* acima)`,
    `  documento (buyer_cpf_id)  ${textoDoDocumento(doc)}`,
    `  nome (recipient name) ... ${TEXTO_SITUACAO[r.comprador.nome]}`,
    '',
    '## Cliente',
  );
  const cl = r.cliente;
  if (!cl.vinculado) {
    linhas.push('  vinculado ............... não (o pedido não aponta cliente)');
  } else {
    linhas.push(
      `  vinculado ............... sim — ${cl.id ?? '—'}`,
      `  criado nesta execução ... ${cl.criado === null ? '—' : simNao(cl.criado)}   (o banco em memória começa sem clientes)`,
      `  campos preenchidos ...... ${lista(cl.camposPreenchidos)}`,
    );
  }

  const e = r.endereco;
  // The stub answered "unknown" to a CEP the importer asked about: the stored UF
  // is the builder's fallback, where production's ViaCEP would normally answer.
  const stubFalhou = r.viaCep.modo === 'stub' && r.viaCep.consultas > 0;
  linhas.push(
    '',
    '## Endereço',
    `  construtor (captura) .... ${e.construtor}`,
    `  portões recusados ....... ${lista(e.portoesRecusados)}`,
    `  CEP da captura .......... ${e.digitosDoCep === null ? '— (ausente ou mascarado)' : `${String(e.digitosDoCep)} dígito(s)`}`,
  );
  if (!e.vinculado) {
    linhas.push('  vinculado ............... não (o pedido não aponta endereço fiscal)');
  } else {
    linhas.push(
      `  vinculado ............... sim (o id é um hash do endereço: não sai no relatório)`,
      `  UF gravada .............. ${e.uf ?? '—'}${stubFalhou ? '   ⚠️ fallback do construtor — o STUB do ViaCEP não resolveu (ver ## ViaCEP)' : ''}`,
      `  país (pais) ............. ${e.pais ?? 'BR (pais nulo)'}`,
      `  codigoMunicipio ......... ${e.codigoMunicipioPreenchido === true ? 'preenchido' : 'vazio — a emissão resolve pelo CMUN'}`,
      `  campos preenchidos ...... ${lista(e.camposPreenchidos)}`,
      `  fallbacks do construtor . ${lista(e.fallbacks)}`,
    );
  }

  linhas.push('');
  if (r.pedido === null) {
    linhas.push('## Pedido', '  (nenhum pedido gravado — ver o resultado da 1ª passada)');
  } else {
    linhas.push(...renderResumoPedido(r.pedido, r.pagamentos));
  }

  linhas.push(
    '',
    '## Incidentes',
    `  incidentes .............. ${String(r.incidentes)}   (o catálogo em memória está vazio: toda linha fica sem produto)`,
    '',
    '## ViaCEP',
    `  modo .................... ${r.viaCep.modo === 'real' ? 'real (--viacep)' : 'stub — responde "não sei", nada sai'}`,
    `  consultas ............... ${String(r.viaCep.consultas)}`,
  );
  if (stubFalhou) {
    linhas.push(
      '  ⚠️⚠️ O STUB respondeu "não sei": a UF gravada é o AC de fallback do construtor e o',
      '     endereco:uf-desconhecida do diário vem DAÍ. Em produção o importador pergunta ao',
      '     ViaCEP de verdade, que normalmente resolve a UF pelo CEP. A 2ª passada também muda o',
      '     diário por isso (o endereço já vinculado não é reavaliado) — não é, por si, um achado',
      '     de idempotência. Rode de novo com --viacep para ver o que a produção grava.',
    );
  }
  linhas.push(
    '',
    '## 2ª passada — a mesma captura de novo, 5 min depois (idempotência)',
    ...linhasDoResultado(r.segunda),
    `  documentos alterados .... ${String(r.segunda.documentosAlterados.length)}${r.segunda.documentosAlterados.length === 0 ? '' : ` — ${r.segunda.documentosAlterados.join(', ')}`}`,
    `  clientes ................ antes=${r.segunda.clientesAntes} depois=${r.segunda.clientesDepois}`,
    '',
    `  linhas de log do importador: ${String(r.logsGravados)} (no stderr, cada uma varrida antes)`,
  );
  return linhas;
}

/* -------------------------------------------------------------------------- */
/*                                the residue scan                             */
/* -------------------------------------------------------------------------- */

/** One buyer-identifying value of the capture, and the FIELD it came from. */
export interface ValorSensivel {
  readonly campo: string;
  readonly valor: string;
}

/** Below this, after trim, a value matches too much to mean anything (`SP`, `100`). */
const COMPRIMENTO_MINIMO = 4;

/** A pure mask placeholder — stars and spaces only. Never real data. */
const SO_MASCARA = /^[\s*]+$/;

/**
 * `invoice_data` fields that are NOT identifying and that the report legitimately
 * prints in another form: the money (a NF-e total equals the order total, which
 * `R$ 1.500,00` renders as runs the digit match would join) and the status token.
 * Everything else under `invoice_data` — the number, the series, the chave de
 * acesso, anything Shopee adds — is scanned.
 */
const INVOICE_NAO_IDENTIFICADORES = new Set(['total_value', 'products_total_value', 'status']);

function adicionar(saida: ValorSensivel[], campo: string, bruto: unknown): void {
  const valor =
    typeof bruto === 'string'
      ? bruto.trim()
      : typeof bruto === 'number' && Number.isFinite(bruto)
        ? String(bruto)
        : null;
  if (valor === null || valor.length < COMPRIMENTO_MINIMO || SO_MASCARA.test(valor)) return;
  if (saida.some((s) => s.campo === campo && s.valor === valor)) return;
  saida.push({ campo, valor });
}

/** Every string/number leaf under `v`, named by its dotted path. */
function folhas(saida: ValorSensivel[], campo: string, v: unknown, pular?: Set<string>): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => folhas(saida, `${campo}.${String(i)}`, x));
    return;
  }
  const o = objeto(v);
  if (o === null) {
    adicionar(saida, campo, v);
    return;
  }
  for (const [chave, x] of Object.entries(o)) {
    if (pular?.has(chave) === true) continue;
    folhas(saida, `${campo}.${chave}`, x);
  }
}

/**
 * The capture's buyer-identifying values — what the report must NOT contain.
 *
 * Every leaf of `recipient_address` and `invoice_data` (minus the
 * {@link INVOICE_NAO_IDENTIFICADORES}), the document, the buyer's handle and
 * id, the two free texts (`message_to_seller` is the BUYER's), the
 * `payment_info` processor CNPJ and authorization code (the summary prints
 * booleans for both), and the escrow's buyer name and tax registration code.
 */
export function valoresSensiveisDaCaptura(
  linha: Readonly<Record<string, unknown>>,
  escrow: Readonly<Record<string, unknown>> | null,
): ValorSensivel[] {
  const saida: ValorSensivel[] = [];
  folhas(saida, 'recipient_address', linha.recipient_address);
  folhas(saida, 'invoice_data', linha.invoice_data, INVOICE_NAO_IDENTIFICADORES);
  adicionar(saida, 'buyer_cpf_id', linha.buyer_cpf_id);
  adicionar(saida, 'buyer_username', linha.buyer_username);
  const id = linha.buyer_user_id;
  if ((typeof id === 'number' && id > 0) || (typeof id === 'string' && /^[1-9]\d*$/.test(id))) {
    adicionar(saida, 'buyer_user_id', id);
  }
  adicionar(saida, 'message_to_seller', linha.message_to_seller);
  adicionar(saida, 'note', linha.note);
  const pagamentos = Array.isArray(linha.payment_info) ? linha.payment_info : [];
  pagamentos.forEach((p, i) => {
    const pag = objeto(p);
    adicionar(
      saida,
      `payment_info.${String(i)}.payment_processor_register`,
      pag?.payment_processor_register,
    );
    adicionar(saida, `payment_info.${String(i)}.transaction_id`, pag?.transaction_id);
  });
  if (escrow !== null) {
    adicionar(saida, 'escrow.buyer_user_name', escrow.buyer_user_name);
    adicionar(
      saida,
      'escrow.order_income.tax_registration_code',
      objeto(escrow.order_income)?.tax_registration_code,
    );
  }
  return saida;
}

/** Separators a FORMATTED number carries between its digit groups (CPF, CNPJ, phone, CEP). */
const SEPARADORES_DO_VALOR = /[\s.\-/()+]/g;
/** A gap between two digit runs of the TEXT that still reads as one formatted number. */
const LACUNA_DE_SEPARADOR = /^[\s.\-/()+]{1,3}$/;
/**
 * A sha256-shaped hex id (≥ 32 hex chars, at least one letter AND one digit):
 * blanked before the digit match, so a short value that happens to sit inside
 * a pedido id between two hex letters is not a hit. A real value never prints
 * INSIDE such an id; a hash of it is not the value.
 *
 * ⚠️ Only a WHOLE token — no letter or digit on either side. Unbounded, the
 * run would start inside a word: `NFe<44 digits>` (the chave de acesso in its
 * XML `Id` form) reads `Fe` + digits as one hex run, and blanking it would hide
 * the chave from the digit match.
 */
const ID_HEX = /(?<![0-9a-z])[0-9a-f]{32,}(?![0-9a-z])/gi;

/** A value that is a NUMBER once its separators are dropped (≥ 4 digits) — its digits, else `null`. */
function digitosDoValor(valor: string): string | null {
  const digitos = valor.replace(SEPARADORES_DO_VALOR, '');
  return digitos.length >= COMPRIMENTO_MINIMO && /^\d+$/.test(digitos) ? digitos : null;
}

/**
 * The text's digit runs, grouped into CHAINS: consecutive runs whose gap is a
 * short separator (`123.456.789-09`, `(11) 98888-7777`, `01001-000`).
 */
function cadeiasDeDigitos(texto: string): string[][] {
  const limpo = texto.replace(ID_HEX, (m) => (/[a-f]/i.test(m) && /\d/.test(m) ? '#' : m));
  const cadeias: string[][] = [];
  let atual: string[] = [];
  let fimAnterior = -1;
  for (const m of limpo.matchAll(/\d+/g)) {
    const inicio = m.index;
    if (atual.length > 0 && !LACUNA_DE_SEPARADOR.test(limpo.slice(fimAnterior, inicio))) {
      cadeias.push(atual);
      atual = [];
    }
    atual.push(m[0]);
    fimAnterior = inicio + m[0].length;
  }
  if (atual.length > 0) cadeias.push(atual);
  return cadeias;
}

/**
 * Does `digitos` equal a CONTIGUOUS span of WHOLE runs of one chain? Whole
 * runs, never a substring of one: a 5-digit id inside a 16-digit µs timestamp
 * is a different number, and matching it would refuse every report.
 */
function digitosNoTexto(cadeias: readonly string[][], digitos: string): boolean {
  for (const cadeia of cadeias) {
    for (let i = 0; i < cadeia.length; i += 1) {
      let acumulado = '';
      for (let j = i; j < cadeia.length; j += 1) {
        acumulado += cadeia[j];
        if (acumulado === digitos) return true;
        if (acumulado.length >= digitos.length) break;
      }
    }
  }
  return false;
}

/** Case-, accent- and whitespace-insensitive: NFD, combining marks dropped, lowercased, spaces collapsed. */
function dobrar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const ALFANUMERICO = /[\p{L}\p{N}]/u;

/**
 * Does the folded `valor` occur in the folded text as a whole TOKEN sequence?
 * A value edge that is a letter or a digit must meet a non-alphanumeric
 * neighbour, so a district `Centro` is not found inside `concentrou`.
 */
function textoNoTexto(textoDobrado: string, valor: string): boolean {
  const v = dobrar(valor);
  if (v.length < COMPRIMENTO_MINIMO) return false;
  const bordaInicio = ALFANUMERICO.test(v[0]!);
  const bordaFim = ALFANUMERICO.test(v[v.length - 1]!);
  for (let i = textoDobrado.indexOf(v); i !== -1; i = textoDobrado.indexOf(v, i + 1)) {
    const antes = textoDobrado[i - 1];
    const depois = textoDobrado[i + v.length];
    const okInicio = !bordaInicio || antes === undefined || !ALFANUMERICO.test(antes);
    const okFim = !bordaFim || depois === undefined || !ALFANUMERICO.test(depois);
    if (okInicio && okFim) return true;
  }
  return false;
}

/**
 * The FIELD names whose value appears in `texto` — sorted, unique, never the
 * values. Mostly-digit values (a CPF/CNPJ, a phone, a CEP, a user id) are
 * matched on the text's digit chains, so any punctuation of the same digits is
 * a hit; everything else is matched folded (case and accents ignored).
 */
export function encontrarResiduos(texto: string, sensiveis: readonly ValorSensivel[]): string[] {
  const cadeias = cadeiasDeDigitos(texto);
  const dobrado = dobrar(texto);
  const achados = new Set<string>();
  for (const { campo, valor } of sensiveis) {
    const digitos = digitosDoValor(valor);
    const encontrado =
      digitos !== null ? digitosNoTexto(cadeias, digitos) : textoNoTexto(dobrado, valor);
    if (encontrado) achados.add(campo);
  }
  return [...achados].sort();
}

/* -------------------------------------------------------------------------- */
/*                                 the output                                  */
/* -------------------------------------------------------------------------- */

/** What the `order_sn` becomes in every printed line. */
export const ORDER_SN_REDIGIDO = '«order_sn»';

/**
 * What an endereço's document id becomes in every printed line. That id is
 * legacy `makeEnderecoId` — an UNSALTED sha1 over the buyer's address parts, so
 * one guessed address confirms it, it links the same buyer across reports, and
 * it is the id of the real document in the production corpus. The residue scan
 * cannot see it (it blanks hex ids before matching), so it never prints.
 */
export const ENDERECO_ID_REDIGIDO = '«endereco_id»';

/** Any `enderecos/<id>` path segment — a ref or a path to a document that was never read too. */
const SEGMENTO_DE_ENDERECO = /(enderecos\/)[^/\s,;)'"`]+/g;

/** The endereço ids a read-back names: the document read, and both refs the pedido stores. */
function idsDeEndereco(leitura: LeituraReproducao): string[] {
  const ids: string[] = [];
  if (leitura.endereco !== null) ids.push(leitura.endereco.id);
  const pedido = leitura.pedido?.dados;
  const frete = objeto(pedido?.freteInicial);
  for (const ref of [pedido?.enderecoFiscalOuterRef, frete?.enderecoFreteOuterReference]) {
    const caminho = toDocPathOrNull(ref);
    const partes = caminho === null ? [] : caminho.split('/');
    if (partes.length === 4 && partes[2] === 'enderecos') ids.push(partes[3]!);
  }
  return ids;
}

/** One printed line with the `order_sn` and every endereço id replaced. */
function redigirLinha(linha: string, orderSn: string, enderecos: readonly string[]): string {
  let saida = orderSn.length >= 6 ? linha.split(orderSn).join(ORDER_SN_REDIGIDO) : linha;
  for (const id of enderecos) {
    if (id.length >= COMPRIMENTO_MINIMO) saida = saida.split(id).join(ENDERECO_ID_REDIGIDO);
  }
  return saida.replace(SEGMENTO_DE_ENDERECO, `$1${ENDERECO_ID_REDIGIDO}`);
}

export interface SaidaDaReproducao {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  /** `true` when the report was withheld — the script exits 1. */
  readonly recusado: boolean;
}

/**
 * Render, redact and SCAN — the whole decision about what the script prints.
 *
 * The report goes to stdout only when it carries no residue; otherwise stdout
 * is EMPTY and stderr names the leaking FIELDS. Each recorded console line is
 * scanned on its own and, when it leaks, replaced by nothing — the suppressions
 * are counted, with their field names, on stderr.
 */
export function montarSaidaDaReproducao(
  r: ResultadoReproducao,
  opcoes: { readonly viaCepLigado: boolean; readonly hostsBloqueados: readonly string[] },
): SaidaDaReproducao {
  const sensiveis = valoresSensiveisDaCaptura(r.linhaBruta, r.escrowBruto);
  const enderecos = [...new Set([...idsDeEndereco(r.leitura), ...idsDeEndereco(r.leituraFinal)])];
  const redigir = (linha: string): string => redigirLinha(linha, r.orderSn, enderecos);
  const stderr: string[] = [];

  let suprimidas = 0;
  const camposSuprimidos = new Set<string>();
  for (const bruta of r.logs) {
    const linha = redigir(bruta);
    const residuos = encontrarResiduos(linha, sensiveis);
    if (residuos.length === 0) {
      stderr.push(linha);
    } else {
      suprimidas += 1;
      for (const c of residuos) camposSuprimidos.add(c);
    }
  }
  if (suprimidas > 0) {
    stderr.push(
      `[reproduzir:pedido] ${String(suprimidas)} linha(s) de log suprimida(s) por conter valor do ` +
        `comprador (campos: ${[...camposSuprimidos].sort().join(', ')}).`,
    );
  }
  if (opcoes.hostsBloqueados.length > 0) {
    stderr.push(
      `[reproduzir:pedido] ⚠️ chamadas de rede BLOQUEADAS: ${[...new Set(opcoes.hostsBloqueados)].sort().join(', ')}`,
    );
  }

  const relatorio = renderReproducao(resumoDaReproducao(r, opcoes)).map(redigir);
  const residuos = encontrarResiduos(relatorio.join('\n'), sensiveis);
  if (residuos.length > 0) {
    stderr.push(
      '❌ Relatório RETIDO: ele conteria valor(es) do comprador vindos destes campos da captura:',
      `   ${residuos.join(', ')}`,
      '   Nada do relatório foi impresso. Pode ser coincidência com um texto fixo do relatório',
      '   (um bairro curto, por exemplo): rode com --saida <arquivo fora do checkout> para ver os',
      '   documentos localmente — e reporte o campo, nunca o valor.',
    );
    return { stdout: [], stderr, recusado: true };
  }
  return { stdout: relatorio, stderr, recusado: false };
}

/**
 * The read-back documents WITH their values, for `--saida` only — the one
 * output of this replay that holds buyer data. Pretty JSON, one document.
 */
export function documentosParaSaida(r: ResultadoReproducao): string {
  return `${JSON.stringify(
    {
      aviso:
        'CONTÉM DADOS REAIS DO COMPRADOR. Não cole, não envie, não commite. Apague depois de ler.',
      leituraAposPrimeiraPassada: r.leitura,
      leituraAposSegundaPassada: r.leituraFinal,
      documentosAlteradosPelaSegunda: r.documentosAlterados,
    },
    null,
    2,
  )}\n`;
}

/* -------------------------------------------------------------------------- */
/*                                   errors                                    */
/* -------------------------------------------------------------------------- */

function nomeDaClasse(err: unknown): string {
  if (typeof err !== 'object' || err === null) return typeof err;
  const construtor = (err as { readonly constructor?: { readonly name?: unknown } }).constructor;
  return typeof construtor?.name === 'string' && construtor.name.length > 0
    ? construtor.name
    : 'Object';
}

/**
 * One failure, described without a payload. ⚠️ Two classes are reduced harder
 * than in `importar:pedido`, because here the payload IS a real buyer's: a
 * `ShopeeSchemaError` prints its field PATHS only, and a `ZodError` its issue
 * paths and codes only — a Zod message can quote the value it refused.
 */
export function descreverErroReproducao(err: unknown): string[] {
  if (err instanceof ArgumentoInvalidoError) {
    return [`❌ ${err.message}`, '', USO_REPRODUZIR_PEDIDO];
  }
  if (err instanceof CapturaInvalidaError || err instanceof ArquivoRecusadoError) {
    return [`❌ ${err.message}`];
  }
  if (err instanceof ShopeeSchemaError) {
    return [
      '❌ ShopeeSchemaError — a captura não bate com o schema de wire (o mesmo da produção).',
      `   path=${err.path}`,
      `   campos: ${err.campos.length === 0 ? '(nenhum)' : err.campos.join(', ')}`,
    ];
  }
  if (err instanceof ZodError) {
    return [
      '❌ ZodError — o importador recusou gravar o que mapeou.',
      ...err.issues.map((i) => `   ${i.path.map(String).join('.') || '(raiz)'} (${i.code})`),
    ];
  }
  if (err instanceof ShopeeApiError) {
    // The envelope's own `message` is Shopee prose about THIS order: not printed.
    return [`❌ ${err.name} (${err.kind})`, `   code=${err.code} path=${err.path}`];
  }
  if (err instanceof ShopeeNetworkError) {
    const causa =
      err.cause instanceof ChamadaNaoCapturadaError
        ? `   o importador pediu ${err.cause.path}, que a reprodução não captura.`
        : `   ${err.message}`;
    return ['❌ ShopeeNetworkError', causa];
  }
  if (err instanceof ShopeeHttpError) {
    return ['❌ ShopeeHttpError', `   httpStatus=${String(err.httpStatus)} path=${err.path}`];
  }
  if (err instanceof ShopeeError) return [`❌ ${err.name}`];
  return [`❌ erro inesperado: ${nomeDaClasse(err)}`];
}
