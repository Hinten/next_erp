/**
 * The app's own error classes — what the credential store, the park, the
 * context loader and the connect flow throw about a conta, its credential or
 * this backend's configuration.
 *
 * ⚠️ **None of them extends the package's `AmazonError`, on purpose.** Every
 * class here roots at {@link ErroAppAmazon}, so a step-3 `catch (err instanceof
 * AmazonError)` — written to handle an Amazon answer — can never swallow "this
 * conta is parked" or "the stored credential is corrupt". `erros.test.ts` pins
 * it for every exported subclass.
 *
 * ⚠️ **No message carries a token, a code, a seller id, a ref or a body.**
 * Messages are built HERE from structured, non-secret fields (the conta id,
 * field PATHS, variable NAMES), so a call site cannot add text to one.
 */
import { resumirCampos } from '@delfrance/core/wire';

/**
 * Base class of every error this app raises. Abstract: only a subclass means
 * anything. `integracaoId` is `null` only for a refusal about the backend itself
 * (its configuration, its read switch) rather than about one conta.
 */
export abstract class ErroAppAmazon extends Error {
  readonly integracaoId: string | null;

  constructor(message: string, integracaoId: string | null) {
    super(message);
    this.name = 'ErroAppAmazon';
    this.integracaoId = integracaoId;
  }
}

/** No conta with this id, or it is not an Amazon conta. */
export class ContaAmazonNaoEncontradaError extends ErroAppAmazon {
  constructor(integracaoId: string) {
    super(`Conta da Amazon não encontrada: ${integracaoId}.`, integracaoId);
    this.name = 'ContaAmazonNaoEncontradaError';
  }
}

/** The conta is inactive in the ERP; its flows do not run. */
export class ContaAmazonInativaError extends ErroAppAmazon {
  constructor(integracaoId: string) {
    super(`A conta da Amazon ${integracaoId} está inativa.`, integracaoId);
    this.name = 'ContaAmazonInativaError';
  }
}

/**
 * The conta has no `selling_partner_id`: it was never connected through the
 * OAuth callback, so no inbound event can route to it and no flow can run.
 */
export class ContaAmazonNaoConectadaError extends ErroAppAmazon {
  constructor(integracaoId: string) {
    super(
      `A conta da Amazon ${integracaoId} ainda não foi conectada (sem vendedor). ` +
        'Conecte-a pelo painel da conta.',
      integracaoId,
    );
    this.name = 'ContaAmazonNaoConectadaError';
  }
}

/** The conta holds no LWA credential. */
export class CredencialAmazonAusenteError extends ErroAppAmazon {
  constructor(integracaoId: string) {
    super(
      `A conta da Amazon ${integracaoId} não tem credencial salva. Conecte-a pelo painel da conta.`,
      integracaoId,
    );
    this.name = 'CredencialAmazonAusenteError';
  }
}

/**
 * The stored credential does not parse under the STRICT schema.
 *
 * `campos` holds field PATHS only (`reconexaoPendente.status`, `(raiz)`) —
 * never a value: the document holds a live refresh token. The remedy is a new
 * consent, which overwrites the whole document.
 */
export class CredencialAmazonInvalidaError extends ErroAppAmazon {
  readonly campos: readonly string[];

  constructor(integracaoId: string, campos: readonly string[]) {
    super(
      `A credencial salva da conta da Amazon ${integracaoId} está ilegível ` +
        `(campos: ${resumirCampos(campos)}). Reconecte a conta pelo painel.`,
      integracaoId,
    );
    this.name = 'CredencialAmazonInvalidaError';
    this.campos = campos;
  }
}

/**
 * Amazon refused the conta's CURRENT refresh token and the conta is parked: its
 * flows stop, with no request sent, until an operator reconnects it.
 */
export class ContaAmazonParadaError extends ErroAppAmazon {
  /** The HTTP status of the refusal that parked it. */
  readonly status: number;
  /** ms — when the park was written, for display only. */
  readonly desdeMs: number;

  constructor(integracaoId: string, status: number, desdeMs: number) {
    super(
      `A Amazon recusou a autorização da conta ${integracaoId} (HTTP ${String(status)}). ` +
        'A conta está parada até ser reconectada pelo painel.',
      integracaoId,
    );
    this.name = 'ContaAmazonParadaError';
    this.status = status;
    this.desdeMs = desdeMs;
  }
}

/**
 * The park lost its `lastUpdateTime` precondition on every one of its attempts.
 * Persistent contention on one document is a problem to surface rather than
 * something to spin on; the caller (a step-3 task) retries later.
 */
export class EstacionamentoAmazonEmConflitoError extends ErroAppAmazon {
  readonly tentativas: number;

  constructor(integracaoId: string, tentativas: number) {
    super(
      `Não foi possível marcar a conta da Amazon ${integracaoId} como parada: ` +
        `${String(tentativas)} escritas seguidas perderam a precondição.`,
      integracaoId,
    );
    this.name = 'EstacionamentoAmazonEmConflitoError';
    this.tentativas = tentativas;
  }
}

/**
 * The read switch (`AMAZON_CHAMADAS`, `core/valvulas.ts`) is not exactly `on`:
 * refused before any Firestore read and before a client exists, so nothing was
 * sent to Amazon (D11). A step-3 task DEFERS on it; a route answers 503.
 */
export class ChamadasAmazonDesligadasError extends ErroAppAmazon {
  constructor(integracaoId: string | null) {
    super(
      'As chamadas à Amazon estão desligadas neste backend' +
        (integracaoId === null ? '' : ` (conta ${integracaoId})`) +
        '. Nada foi enviado à Amazon.',
      integracaoId,
    );
    this.name = 'ChamadasAmazonDesligadasError';
  }
}

/**
 * This backend lacks configuration a flow needs. `chaves` holds the variable
 * NAMES — missing, or present with a value the package refused — never a value.
 */
export class ConfigAmazonAusenteError extends ErroAppAmazon {
  readonly chaves: readonly string[];

  constructor(chaves: readonly string[], integracaoId: string | null = null) {
    super(
      `Configuração da Amazon ausente ou inválida neste backend: ${chaves.join(', ')}.`,
      integracaoId,
    );
    this.name = 'ConfigAmazonAusenteError';
    this.chaves = chaves;
  }
}
