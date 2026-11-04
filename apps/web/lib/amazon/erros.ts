/**
 * The failures of a call to the `apps/amazon` conta routes, and the pt-BR copy
 * each one earns.
 *
 * Three classes, one per way a call can fail:
 *
 * | class | when | `codigo` |
 * | --- | --- | --- |
 * | {@link AmazonBackendError} | a non-2xx answer | the envelope's `code`, or `null` when the body is not our envelope |
 * | {@link AmazonRespostaInvalidaError} | a 2xx whose body is not the shape the contract claims | `null` |
 * | {@link AmazonRedeError} | the request never got an answer (or its body dropped mid-read) | — |
 *
 * ⚠️ Copy is keyed on `codigo` FIRST and on the status only for a body that is
 * not our envelope. A status is not one meaning: a 503 is the read switch being
 * off (retrying cannot help) or a platform hiccup (it can), and a 500 is a
 * missing variable, a Firebase Admin that failed to start, or a crash — each
 * asks the operator for something different.
 *
 * Two families of `codigo` exist on these routes:
 *
 *  1. {@link CODIGO_ERRO_AMAZON} — the conta routes' own codes, a closed set in
 *     the shared contract (`@delfrance/schemas`, `contaAmazon.ts`). The copy is a
 *     `Record` over it, so a code the contract gains fails typecheck here until
 *     it has a sentence.
 *  2. `verifyCaller`'s codes (`@delfrance/data/admin/auth`): a 401 carrying the
 *     Firebase Auth code (`auth/id-token-expired`, `auth/id-token-revoked`, …)
 *     and a 500 carrying the Admin init code (`app/…`). Open-ended — Firebase
 *     owns the list — so they are matched by FAMILY (the prefix), never one by
 *     one. Its CODELESS answers (a 401 for a missing Bearer token, the 403 for a
 *     missing permission) are matched by status.
 *
 * A `codigo` from neither family — one a newer backend added — shows the
 * backend's own sentence: it is pt-BR text this repo wrote, built from ids and
 * variable names only (the contract promises no envelope carries a token, a
 * code, a state, a seller id or a ref).
 */
import { CODIGO_ERRO_AMAZON, type CodigoErroAmazon } from '@delfrance/schemas';

/** A non-2xx answer from the `apps/amazon` backend. */
export class AmazonBackendError extends Error {
  /** Field PATHS the backend blamed (`issues` on the envelope), never values. */
  readonly campos: readonly string[];

  constructor(
    /**
     * The backend's own sentence (`error` on the envelope) when the body was our
     * envelope, else a sentence built from the status. Never a raw body: a
     * proxy's whole HTML page would bury the cause.
     */
    message: string,
    readonly status: number,
    /**
     * The envelope's `code`, or `null` when the body was not our envelope (an
     * HTML page, `verifyCaller`'s codeless 401/403). A plain string: a code a
     * newer backend adds must still reach the copy. ⚠️ Key copy on THIS, never
     * on `status` alone.
     */
    readonly codigo: string | null,
    campos: readonly string[] = [],
  ) {
    super(message);
    this.name = 'AmazonBackendError';
    this.campos = campos;
  }
}

/**
 * The backend answered 2xx and the body was not the shape the contract claims —
 * the wrong fields, no body at all, or not JSON (a proxy's HTML page).
 *
 * ⚠️ A SUBCLASS of {@link AmazonBackendError}, matching the sibling clients:
 * catch sites narrow to the base and rethrow anything else, so a sibling class
 * would land as an unhandled rejection instead of a message. Narrow it FIRST:
 * it is never retryable, whatever its status.
 */
export class AmazonRespostaInvalidaError extends AmazonBackendError {
  constructor(
    message: string,
    /** The real 2xx the backend sent — never a hardcoded 200. */
    status: number,
    /** Field PATHS that failed, never values. */
    campos: readonly string[],
  ) {
    super(message, status, null, campos);
    this.name = 'AmazonRespostaInvalidaError';
  }
}

/**
 * The request never got an answer: a refused connection, a CORS refusal, a
 * socket that dropped mid-body.
 *
 * ⚠️ The message is a FIXED sentence: the transport's own text stays on
 * `cause`, so nothing a runtime chose to put in it can reach the operator's
 * screen or a log through `err.message`.
 */
export class AmazonRedeError extends Error {
  constructor(override readonly cause?: unknown) {
    super('Falha de rede ao contatar o backend da Amazon.');
    this.name = 'AmazonRedeError';
  }
}

/**
 * The copy for each conta-route code. TOTAL by typecheck over
 * {@link CodigoErroAmazon}: a code the contract gains does not compile here
 * until it has a sentence.
 *
 * `AMAZON_CONFIG_AUSENTE` gets the backend's own sentence appended by
 * {@link mensagemErroAmazon} — it names the missing variables, never a value.
 */
export const MENSAGENS_CODIGO_ERRO_AMAZON: Readonly<Record<CodigoErroAmazon, string>> = {
  [CODIGO_ERRO_AMAZON.ID_INVALIDO]:
    'O endereço desta página não traz um id de conta válido. Volte à lista de contas.',
  [CODIGO_ERRO_AMAZON.CONTA_NAO_ENCONTRADA]:
    'O backend da Amazon não encontrou esta conta, ou ela não é uma conta da Amazon. Volte à ' +
    'lista de contas.',
  [CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS]:
    'A integração com a Amazon fica desligada até a virada: até a migração para este sistema ' +
    '(ou por configuração do backend), nenhuma chamada à Amazon é feita. Nada foi enviado à ' +
    'Amazon nem salvo. Se a migração já ocorreu, avise o suporte.',
  [CODIGO_ERRO_AMAZON.CONFIG_AUSENTE]:
    'O backend da Amazon está sem a configuração da conexão. Avise quem cuida do deploy.',
};

/** Is `codigo` one of the conta routes' own codes? */
export function ehCodigoErroAmazon(codigo: string | null): codigo is CodigoErroAmazon {
  return codigo !== null && Object.hasOwn(MENSAGENS_CODIGO_ERRO_AMAZON, codigo);
}

/** `verifyCaller` answers a rejected ID token with the Firebase Auth code (401). */
const PREFIXO_CODIGO_AUTH = 'auth/';
/** `verifyCaller` answers a Firebase Admin that failed to start with the app code (500). */
const PREFIXO_CODIGO_APP = 'app/';

const MENSAGEM_SESSAO =
  'O backend da Amazon não aceitou sua sessão (o login expirou ou foi revogado). Recarregue a ' +
  'página e entre de novo.';
const MENSAGEM_ADMIN =
  'O backend da Amazon não conseguiu iniciar o acesso ao banco de dados (configuração do ' +
  'servidor). Avise quem cuida do deploy.';
const MENSAGEM_SEM_PERMISSAO =
  'Você não tem permissão para esta operação no backend da Amazon (requer a permissão de ' +
  'integrações).';

/**
 * What to say when the backend answered a non-2xx WITHOUT a code — the request
 * never reached a conta route (a proxy page, a platform timeout, a backend that
 * predates these routes), or it is `verifyCaller`'s codeless 401/403.
 */
export function mensagemHttpAmazon(status: number): string {
  if (status === 401) return MENSAGEM_SESSAO;
  if (status === 403) return MENSAGEM_SEM_PERMISSAO;
  if (status === 404) {
    return (
      `O backend da Amazon não respondeu por esta rota (HTTP ${String(status)}). Atualize a ` +
      'página e, se continuar, avise o suporte.'
    );
  }
  if (status >= 500) {
    return `O backend da Amazon falhou (HTTP ${String(status)}). Tente novamente em instantes.`;
  }
  return `Falha na comunicação com o backend da Amazon (HTTP ${String(status)}).`;
}

/**
 * The operator's copy for a failed call. TOTAL over {@link AmazonBackendError}:
 * a conta-route code, then a `verifyCaller` code family, then the backend's own
 * sentence for a code this build does not know, then the status.
 *
 * {@link AmazonRespostaInvalidaError} keeps the sentence the client built for
 * it (it names the field paths and says what to do).
 */
export function mensagemErroAmazon(err: AmazonBackendError): string {
  if (err instanceof AmazonRespostaInvalidaError) return err.message;
  const { codigo } = err;
  if (ehCodigoErroAmazon(codigo)) {
    const copia = MENSAGENS_CODIGO_ERRO_AMAZON[codigo];
    return codigo === CODIGO_ERRO_AMAZON.CONFIG_AUSENTE ? `${copia} ${err.message}` : copia;
  }
  if (codigo !== null && codigo.startsWith(PREFIXO_CODIGO_AUTH)) return MENSAGEM_SESSAO;
  if (codigo !== null && codigo.startsWith(PREFIXO_CODIGO_APP)) return MENSAGEM_ADMIN;
  if (codigo !== null) return err.message;
  return mensagemHttpAmazon(err.status);
}

/**
 * Whether repeating the SAME call could plausibly help.
 *
 * Never for a 2xx this build cannot read, a conta-route code (each is a verdict:
 * a bad id, no such conta, the switch off, a missing variable), a rejected
 * session or a Firebase Admin that failed to start — each answers the same way
 * until someone acts. A codeless 5xx may be transient; `501` is as permanent as
 * a 4xx.
 */
export function repetivelAmazon(err: AmazonBackendError): boolean {
  if (err instanceof AmazonRespostaInvalidaError) return false;
  if (err.codigo !== null) return false;
  return err.status >= 500 && err.status !== 501;
}
