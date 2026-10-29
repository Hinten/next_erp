/**
 * The app's own error classes — what the credential store, the park and the
 * context loader throw. `core/respond.ts` maps each to an HTTP answer.
 *
 * ⚠️ **None of them extends the package's `LiError`, on purpose.** Every class
 * here roots at {@link LiAppError}, so a step-3 `catch (err instanceof LiError)`
 * — written to handle a Loja Integrada answer — can never swallow "this conta is
 * parked" or "the stored credential is corrupt". `erros.test.ts` pins it for
 * every exported subclass.
 *
 * ⚠️ **No message carries a token, a fingerprint, a ref or a body.** Messages
 * are built HERE from structured, non-secret fields (the conta id, field PATHS),
 * so a call site cannot add text to one.
 */
import { resumirCampos } from '@delfrance/core/wire';

/**
 * Base class of every error this app raises about a conta or its credential.
 * Abstract: only a subclass has an HTTP mapping (`respond.ts`).
 */
export abstract class LiAppError extends Error {
  readonly integracaoId: string;

  constructor(message: string, integracaoId: string) {
    super(message);
    this.name = 'LiAppError';
    this.integracaoId = integracaoId;
  }
}

/** No conta with this id, or it is not a Loja Integrada conta. */
export class LiContaNaoEncontradaError extends LiAppError {
  constructor(integracaoId: string) {
    super(`Conta da Loja Integrada não encontrada: ${integracaoId}.`, integracaoId);
    this.name = 'LiContaNaoEncontradaError';
  }
}

/** The conta is inactive in the ERP; its flows do not run. */
export class LiContaInativaError extends LiAppError {
  constructor(integracaoId: string) {
    super(`A conta da Loja Integrada ${integracaoId} está inativa.`, integracaoId);
    this.name = 'LiContaInativaError';
  }
}

/** The conta holds no Personal Token. */
export class LiCredencialAusenteError extends LiAppError {
  constructor(integracaoId: string) {
    super(
      `A conta da Loja Integrada ${integracaoId} não tem token salvo. Salve um Personal Token na conta.`,
      integracaoId,
    );
    this.name = 'LiCredencialAusenteError';
  }
}

/**
 * The stored credential does not parse under the STRICT schema.
 *
 * `campos` holds field PATHS only (`reconexaoPendente.status`, `(raiz)`) — never
 * a value: the document holds a live token. The remedy is to remove the token
 * and save it again.
 */
export class LiCredencialInvalidaError extends LiAppError {
  readonly campos: readonly string[];

  constructor(integracaoId: string, campos: readonly string[]) {
    super(
      `A credencial salva da conta da Loja Integrada ${integracaoId} está ilegível ` +
        `(campos: ${resumirCampos(campos)}). Remova o token e salve-o de novo.`,
      integracaoId,
    );
    this.name = 'LiCredencialInvalidaError';
    this.campos = campos;
  }
}

/**
 * The credential changed after the read a write was decided on — another
 * operator saved, renewed or removed it, or a 401 parked it. A lost race is
 * reported, never overwritten (root rule 7, tier 3).
 */
export class LiCredencialAlteradaError extends LiAppError {
  constructor(integracaoId: string) {
    super(
      `A credencial da conta da Loja Integrada ${integracaoId} mudou enquanto era editada. ` +
        'Recarregue, confira e salve de novo.',
      integracaoId,
    );
    this.name = 'LiCredencialAlteradaError';
  }
}

/**
 * The credential PIN of a write run (`core/contextoEscrita.ts`): the stored
 * credential is no longer the one the run's deciding read used — a token saved,
 * renewed or re-saved since. The write client refuses BEFORE any request, so
 * nothing was sent: a write and its confirming read are made with the deciding
 * read's credential or not at all, and a token swapped between two contas can
 * never write onto the other store's order of the same numero.
 *
 * Transient: the next attempt decides afresh, from a fresh read with the new
 * token. Not {@link LiCredencialAlteradaError}, the credential panel's lost race.
 */
export class LiCredencialTrocadaError extends LiAppError {
  constructor(integracaoId: string) {
    super(
      `A credencial da conta da Loja Integrada ${integracaoId} mudou depois da leitura que ` +
        'decidiu a escrita. Nada foi enviado; a próxima tentativa decide de novo.',
      integracaoId,
    );
    this.name = 'LiCredencialTrocadaError';
  }
}

/**
 * Loja Integrada refused the stored token (HTTP 401/403) and the conta is
 * parked: its flows stop until a valid token is saved.
 */
export class LiContaParadaError extends LiAppError {
  readonly status: 401 | 403;
  /** ms — when the park was written, for display only. */
  readonly desdeMs: number;

  constructor(integracaoId: string, status: 401 | 403, desdeMs: number) {
    super(
      `A Loja Integrada recusou o token da conta ${integracaoId} (HTTP ${String(status)}). ` +
        'A conta está parada até salvar um token válido.',
      integracaoId,
    );
    this.name = 'LiContaParadaError';
    this.status = status;
    this.desdeMs = desdeMs;
  }
}

/**
 * The park lost its `lastUpdateTime` precondition on every one of its attempts.
 * Persistent contention on one document is a real problem rather than something
 * to spin on; the caller (a task) retries later.
 */
export class LiEstacionamentoEmConflitoError extends LiAppError {
  readonly tentativas: number;

  constructor(integracaoId: string, tentativas: number) {
    super(
      `Não foi possível marcar a conta da Loja Integrada ${integracaoId} como parada: ` +
        `${String(tentativas)} escritas seguidas perderam a precondição.`,
      integracaoId,
    );
    this.name = 'LiEstacionamentoEmConflitoError';
    this.tentativas = tentativas;
  }
}

/**
 * A Loja Integrada WRITE refused with 401/403 while the SAME, pinned credential
 * still READS (the confirming read succeeded): the status write-back's retry
 * signal (master plan step 7). The conta is NOT parked — the token reads, so the
 * refusal may be a gateway blip or a write-only refusal — and the whole job is
 * retried on the queue's existing ladder, each try from a fresh guard read; only
 * the hot lane's last pass concludes, with an aviso, instead of throwing this.
 *
 * Transient. ⚠️ A plain `Error`, NOT a {@link LiAppError}: it is never answered
 * by a route (`respond.ts` maps conta refusals only), and a `catch` written for a
 * conta's refusal must not swallow it. Not a package `LiError` either. Its
 * message carries the conta, the write kind and the status — never a body, a
 * path or a token.
 */
export class EscritaRecusadaLiError extends Error {
  readonly integracaoId: string;
  /** The write kind that was refused (`objeto-envio`, `situacao-pedido`). */
  readonly tipo: string;
  readonly status: number;

  constructor(integracaoId: string, tipo: string, status: number) {
    super(
      `A Loja Integrada recusou a escrita ${tipo} da conta ${integracaoId} (HTTP ${String(status)}), ` +
        'mas o token ainda lê pedidos: a tarefa será tentada de novo.',
    );
    this.name = 'EscritaRecusadaLiError';
    this.integracaoId = integracaoId;
    this.tipo = tipo;
    this.status = status;
  }
}

/**
 * The read switch (`LOJA_INTEGRADA_CHAMADAS`, `core/valvulas.ts`) is not exactly
 * `on`: the context loader refuses before any Firestore read and before a client
 * exists, so nothing was sent to Loja Integrada (D17: mock only until the window
 * sets the switch). A precondition outside this code — a step-3 task DEFERS on
 * it — and on a route the 503 `LI_CHAMADAS_DESLIGADAS`.
 */
export class LiChamadasDesligadasError extends LiAppError {
  constructor(integracaoId: string) {
    super(
      `As chamadas à Loja Integrada estão desligadas neste backend (conta ${integracaoId}). ` +
        'Nada foi enviado à Loja Integrada.',
      integracaoId,
    );
    this.name = 'LiChamadasDesligadasError';
  }
}
