/**
 * Typed error hierarchy for the Loja Integrada REST v1 client, plus the two
 * readers a rate-limited answer needs (`extrairEscopoLimite`, `lerRetryAfter`).
 *
 * Every class roots at {@link LiError}, so a caller narrows with `instanceof`
 * (repo rule 6) and maps the class to an HTTP answer, a parking decision or a
 * retry. The HTTP subclasses root at {@link LiHttpError}; the 2xx-with-a-bad-body
 * class ({@link LiSchemaError}) and the transport classes do NOT, so an
 * `instanceof LiHttpError` arm can never swallow them.
 *
 * ## What an error may carry
 *
 * ⚠️ **No part of a response body, ever.** A Loja Integrada body can carry a
 * buyer's name, e-mail or CPF, and an error travels further than any log line:
 * into `err.message`, a route's 5xx answer, a durable failure doc. The body
 * reaches exactly one place, the `onChamada` observer (`client.ts`), already
 * scrubbed of the token, and the app's logger decides there what is kept.
 *
 * ⚠️ **Messages name the operation and the path, and nothing else.** Never the
 * token, never a query value, never a body value, never the `message` of a
 * caught platform error (an aborted `fetch` can echo its URL). That is why every
 * message is BUILT HERE from structured fields rather than passed in by the
 * caller: a call site cannot add text to one.
 *
 * `refCredencial` is the opaque, non-secret label the caller handed in with the
 * token (`CredencialLi.ref`), echoed so the app can tell WHICH credential a 401
 * belonged to. It is `null` only when the error was raised before the
 * credential getter resolved, or when echoing it is unsafe (a rejected token or
 * a rejected `ref`).
 */
import { resumirCampos } from '@delfrance/core/wire';

/* -------------------------------------------------------------------------- */
/*                                The 429 scope                               */
/* -------------------------------------------------------------------------- */

/** The three rate-limit codes Loja Integrada documents, one per bucket. */
export type CodigoLimiteLi = 633 | 533 | 133;

/** Which bucket a 429 came from; `'desconhecido'` when the body does not say. */
export type EscopoLimiteLi = 'loja' | 'aplicacao' | 'ip' | 'desconhecido';

const ESCOPO_POR_CODIGO = {
  633: 'loja',
  533: 'aplicacao',
  133: 'ip',
} as const satisfies Record<CodigoLimiteLi, EscopoLimiteLi>;

/** Text → code, so a match never needs a cast. */
const CODIGO_POR_TEXTO: Readonly<Record<string, CodigoLimiteLi>> = {
  '633': 633,
  '533': 533,
  '133': 133,
};

/**
 * One of the three codes, standing alone.
 *
 * ⚠️ The boundaries are ALPHANUMERIC, not digits only. Loja Integrada echoes
 * the request's correlation UUID in its error bodies, and a hex group such as
 * `a633f` must not read as a code. A digit-only boundary also covers `1633`,
 * `5330` and `133000`; the letters are what the UUID adds.
 */
const CODIGO_LIMITE = /(?<![0-9A-Za-z])(633|533|133)(?![0-9A-Za-z])/g;

export interface LeituraLimiteLi {
  readonly escopo: EscopoLimiteLi;
  /** The single code found, or `null` when there were zero or several distinct ones. */
  readonly codigo: CodigoLimiteLi | null;
  /** Every distinct code found, in order of first appearance. */
  readonly codigosEncontrados: readonly CodigoLimiteLi[];
}

/**
 * Read the bucket of a 429 from its raw body text.
 *
 * Exactly ONE distinct code maps to its scope (633 → `loja`, 533 →
 * `aplicacao`, 133 → `ip`). Zero codes, or two or more distinct ones, answer
 * `'desconhecido'`: a body naming two buckets does not say which one we hit,
 * and guessing would pace the wrong thing.
 *
 * ⚠️ Called on a **429 only**. A 400 whose text happens to contain `633` is not
 * a rate limit, and reading it as one would put a validation failure on the
 * throttle ladder. The scope only enriches logs and pacing; every 429 throws the
 * same class whatever it says.
 */
export function extrairEscopoLimite(texto: string): LeituraLimiteLi {
  const encontrados: CodigoLimiteLi[] = [];
  for (const m of texto.matchAll(CODIGO_LIMITE)) {
    const codigo = m[1] === undefined ? undefined : CODIGO_POR_TEXTO[m[1]];
    if (codigo !== undefined && !encontrados.includes(codigo)) encontrados.push(codigo);
  }
  const [unico] = encontrados;
  if (encontrados.length !== 1 || unico === undefined) {
    return { escopo: 'desconhecido', codigo: null, codigosEncontrados: encontrados };
  }
  return { escopo: ESCOPO_POR_CODIGO[unico], codigo: unico, codigosEncontrados: encontrados };
}

/**
 * `Retry-After` as whole seconds, or `null`.
 *
 * Only the delta-seconds form is read: `/^\d+$/` after a trim, and within the
 * safe-integer range. The HTTP-date form would need a clock and a date parse to
 * become a delay (and `Date.parse` is banned here, `no-lossy-date-parse`), so it
 * answers `null` and the caller falls back to its own pacing — strictly better
 * than a delay computed from a guess. Same rule as Shopee's `parseRetryAfter`.
 */
export function lerRetryAfter(valor: string | null | undefined): number | null {
  if (valor === null || valor === undefined) return null;
  const t = valor.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/* -------------------------------------------------------------------------- */
/*                                 The classes                                */
/* -------------------------------------------------------------------------- */

/** What identifies one request on every error raised after it was built. */
export interface ContextoRequisicaoLi {
  /** The caller's label for the call (`'validarPersonalToken'`, …). */
  readonly operacao: string;
  /** The path only — never the query, which may carry filter values. */
  readonly caminho: string;
  readonly correlationId: string;
  readonly refCredencial: string;
}

/** Base class for every error this package raises. */
export class LiError extends Error {
  /** The caller's opaque credential label, or `null` (see the module header). */
  readonly refCredencial: string | null;
  override readonly cause: unknown;

  constructor(
    message: string,
    init: { readonly refCredencial: string | null; readonly cause?: unknown },
  ) {
    super(message);
    this.name = 'LiError';
    this.refCredencial = init.refCredencial;
    this.cause = init.cause;
  }
}

/** Why a request was refused before anything was sent. */
export type MotivoConfigLi = 'token' | 'ref' | 'caminho' | 'token-na-url' | 'maxPaginas';

/**
 * OUR input was unusable, and **no request was made**.
 *
 * - `'token'` — empty, or a character outside visible ASCII (`\x21-\x7E`):
 *   whitespace, a line break, a control character, anything non-ASCII.
 * - `'ref'` — empty, longer than 64 characters, or containing the token.
 * - `'caminho'` — not under `/v1/`, carrying `?`, `#`, `://`, `..` or an encoded
 *   `.`, `/` or `\`, or rewritten by the URL parser (a tab, a `%2e%2e` segment).
 * - `'token-na-url'` — the token appears in the path or in a query key or value.
 *   It travels in `Authorization` only.
 * - `'maxPaginas'` — not a positive safe integer.
 *
 * ⚠️ The message never echoes the offending value: a rejected token is still a
 * token, a rejected `ref` may contain one, and a rejected path may carry a query.
 */
export class LiConfigError extends LiError {
  readonly motivo: MotivoConfigLi;
  readonly operacao: string;

  constructor(
    motivo: MotivoConfigLi,
    init: { readonly operacao: string; readonly refCredencial: string | null },
  ) {
    super(mensagemDeConfig(motivo, init.operacao), { refCredencial: init.refCredencial });
    this.name = 'LiConfigError';
    this.motivo = motivo;
    this.operacao = init.operacao;
  }
}

function mensagemDeConfig(motivo: MotivoConfigLi, operacao: string): string {
  const prefixo = `Loja Integrada (${operacao}):`;
  switch (motivo) {
    case 'token':
      return `${prefixo} o token está vazio ou tem caractere fora do ASCII visível (espaço, quebra de linha, caractere de controle ou acento). Nada foi enviado.`;
    case 'ref':
      return `${prefixo} a referência da credencial está vazia, passa de 64 caracteres ou contém o token. Nada foi enviado.`;
    case 'caminho':
      return `${prefixo} o caminho precisa começar com /v1/, não pode conter ?, #, :// ou ".." (nem codificados) e precisa chegar ao servidor exatamente como foi escrito. Nada foi enviado.`;
    case 'token-na-url':
      return `${prefixo} o token aparece no caminho ou na query; ele só pode viajar no cabeçalho Authorization. Nada foi enviado.`;
    case 'maxPaginas':
      return `${prefixo} maxPaginas precisa ser um inteiro positivo.`;
  }
}

/** A non-2xx is transient when a later identical request can succeed. */
function ehTransitorio(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * A non-2xx that no subclass below claims — including a 3xx (redirects are
 * never followed, so a moved endpoint fails visibly) and a 400.
 *
 * `transitorio` is `true` for 5xx (Loja Integrada's non-standard 52x included)
 * and for 429, `false` otherwise.
 */
export class LiHttpError extends LiError {
  readonly status: number;
  readonly transitorio: boolean;
  readonly operacao: string;
  readonly caminho: string;
  readonly correlationId: string;

  constructor(init: ContextoRequisicaoLi & { readonly status: number }, mensagem?: string) {
    super(
      mensagem ??
        `A Loja Integrada respondeu HTTP ${String(init.status)} em ${init.operacao} (GET ${init.caminho}).`,
      { refCredencial: init.refCredencial },
    );
    this.name = 'LiHttpError';
    this.status = init.status;
    this.transitorio = ehTransitorio(init.status);
    this.operacao = init.operacao;
    this.caminho = init.caminho;
    this.correlationId = init.correlationId;
  }
}

/**
 * 401 or 403: the credential was refused. In the app this is the signal to park
 * the conta — compared against `refCredencial`, so a 401 that belonged to an
 * older token does not park a conta that has since been reconnected.
 */
export class LiAuthError extends LiHttpError {
  constructor(init: ContextoRequisicaoLi & { readonly status: number }) {
    super(
      init,
      `A Loja Integrada recusou a credencial (HTTP ${String(init.status)}) em ${init.operacao} (GET ${init.caminho}).`,
    );
    this.name = 'LiAuthError';
  }
}

/** 404. */
export class LiNotFoundError extends LiHttpError {
  constructor(init: ContextoRequisicaoLi & { readonly status: number }) {
    super(
      init,
      `A Loja Integrada respondeu HTTP 404 (não encontrado) em ${init.operacao} (GET ${init.caminho}).`,
    );
    this.name = 'LiNotFoundError';
  }
}

/**
 * 429. Always `transitorio: true`: a throttle is the textbook case for backing
 * off and retrying, and the app's task queue relies on it.
 */
export class LiThrottleError extends LiHttpError {
  readonly escopo: EscopoLimiteLi;
  readonly codigosEncontrados: readonly CodigoLimiteLi[];
  /** From the `Retry-After` header, when it was a whole number of seconds. */
  readonly retryAfterS: number | null;

  constructor(
    init: ContextoRequisicaoLi & {
      readonly status: number;
      readonly escopo: EscopoLimiteLi;
      readonly codigosEncontrados: readonly CodigoLimiteLi[];
      readonly retryAfterS: number | null;
    },
  ) {
    super(
      init,
      `A Loja Integrada limitou as requisições (HTTP ${String(init.status)}, escopo ${init.escopo}) em ${init.operacao} (GET ${init.caminho}).`,
    );
    this.name = 'LiThrottleError';
    this.escopo = init.escopo;
    this.codigosEncontrados = init.codigosEncontrados;
    this.retryAfterS = init.retryAfterS;
  }
}

/** How a 2xx body (or a page's `meta.next`) failed to be what we expect. */
export type MotivoSchemaLi = 'vazio' | 'nao-json' | 'formato';

/**
 * A 2xx whose body is not what the schema says, or a page whose `meta.next`
 * cannot be followed.
 *
 * `campos` holds field PATHS only (`objects[].id`), never values — the same
 * rule as `lerRespostaJson`.
 */
export class LiSchemaError extends LiError {
  readonly status: number;
  readonly motivo: MotivoSchemaLi;
  readonly campos: readonly string[];
  readonly operacao: string;
  readonly caminho: string;
  readonly correlationId: string;

  constructor(
    init: ContextoRequisicaoLi & {
      readonly status: number;
      readonly motivo: MotivoSchemaLi;
      readonly campos: readonly string[];
    },
  ) {
    super(mensagemDeSchema(init), { refCredencial: init.refCredencial });
    this.name = 'LiSchemaError';
    this.status = init.status;
    this.motivo = init.motivo;
    this.campos = init.campos;
    this.operacao = init.operacao;
    this.caminho = init.caminho;
    this.correlationId = init.correlationId;
  }
}

function mensagemDeSchema(
  init: ContextoRequisicaoLi & {
    readonly status: number;
    readonly motivo: MotivoSchemaLi;
    readonly campos: readonly string[];
  },
): string {
  const onde = `em ${init.operacao} (GET ${init.caminho})`;
  const http = `HTTP ${String(init.status)}`;
  switch (init.motivo) {
    case 'vazio':
      return `A Loja Integrada respondeu ${http} sem corpo ${onde}.`;
    case 'nao-json':
      return `A Loja Integrada respondeu ${http} com um corpo que não é JSON ${onde}.`;
    case 'formato':
      return `A Loja Integrada respondeu ${http} fora do formato esperado ${onde}. Campos inválidos: ${resumirCampos(init.campos)}.`;
  }
}

/** Why paging stopped. */
export type MotivoPaginacaoLi = 'limite-de-paginas' | 'offset-nao-avanca';

/**
 * Paging stopped because continuing was unsafe.
 *
 * - `'limite-de-paginas'` — `maxPaginas` pages were read and `meta.next` still
 *   pointed further. It throws rather than truncating: a reconcile that read a
 *   truncated catalogue would act on the missing half.
 * - `'offset-nao-avanca'` — `meta.next` did not move past the current page
 *   (its `meta.offset`, or the offset it was requested at), which would loop for
 *   ever.
 */
export class LiPaginacaoError extends LiError {
  readonly motivo: MotivoPaginacaoLi;
  /** How many pages were read before stopping. */
  readonly paginas: number;
  readonly operacao: string;
  readonly caminho: string;
  /** The correlation id of the last page read. */
  readonly correlationId: string;

  constructor(
    init: ContextoRequisicaoLi & {
      readonly motivo: MotivoPaginacaoLi;
      readonly paginas: number;
    },
  ) {
    super(mensagemDePaginacao(init), { refCredencial: init.refCredencial });
    this.name = 'LiPaginacaoError';
    this.motivo = init.motivo;
    this.paginas = init.paginas;
    this.operacao = init.operacao;
    this.caminho = init.caminho;
    this.correlationId = init.correlationId;
  }
}

function mensagemDePaginacao(
  init: ContextoRequisicaoLi & { readonly motivo: MotivoPaginacaoLi; readonly paginas: number },
): string {
  const onde = `${init.operacao} (GET ${init.caminho})`;
  switch (init.motivo) {
    case 'limite-de-paginas':
      return `A paginação de ${onde} parou após ${String(init.paginas)} páginas: o limite foi atingido e ainda havia próxima página.`;
    case 'offset-nao-avanca':
      return `A paginação de ${onde} parou na página ${String(init.paginas)}: o offset da próxima página não avança.`;
  }
}

/**
 * The transport failed: `fetch` rejected with a `TypeError` (DNS, TLS, a reset
 * connection), or the connection dropped while the BODY streamed.
 *
 * The original `TypeError` rides as `cause`; its `message` is never copied into
 * this one.
 */
export class LiNetworkError extends LiError {
  readonly operacao: string;
  readonly caminho: string;
  readonly correlationId: string;

  constructor(init: ContextoRequisicaoLi, cause: unknown, mensagem?: string) {
    super(
      mensagem ??
        `Falha de rede ao chamar a Loja Integrada em ${init.operacao} (GET ${init.caminho}).`,
      { refCredencial: init.refCredencial, cause },
    );
    this.name = 'LiNetworkError';
    this.operacao = init.operacao;
    this.caminho = init.caminho;
    this.correlationId = init.correlationId;
  }
}

/**
 * The per-call deadline (`PRAZO_LI_MS`) passed. The outcome is unknown — the
 * request may have been served — which for a GET only means "try again".
 * Subclasses {@link LiNetworkError}, as `MelhorEnvioTimeoutError` does, so a
 * network arm keeps catching it.
 */
export class LiTimeoutError extends LiNetworkError {
  readonly prazoMs: number;

  constructor(init: ContextoRequisicaoLi & { readonly prazoMs: number }, cause: unknown) {
    super(
      init,
      cause,
      `A Loja Integrada não respondeu em ${String(init.prazoMs / 1000)} s em ${init.operacao} (GET ${init.caminho}).`,
    );
    this.name = 'LiTimeoutError';
    this.prazoMs = init.prazoMs;
  }
}
