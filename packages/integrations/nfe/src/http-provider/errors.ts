/**
 * Typed errors raised by the HTTP `NFeHttpClient`. Each maps to a
 * specific failure shape `apps/nfe`'s route layer surfaces — the
 * client narrows the HTTP status code into one of these so callers
 * (e.g. `apps/web`) can branch on `err instanceof <X>` without
 * inspecting numeric codes.
 *
 * The base class `NFeHttpError` carries the raw status + body so
 * generic "unexpected" cases still surface diagnostics.
 */

/** Base — every HTTP-originated error is at least this. */
export class NFeHttpError extends Error {
  public readonly status: number;
  public readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'NFeHttpError';
    this.status = status;
    this.body = body;
  }
}

/** 400 — malformed request body / query (Zod parse failure). */
export class NFeBadRequestError extends NFeHttpError {
  constructor(message: string, body: unknown) {
    super(message, 400, body);
    this.name = 'NFeBadRequestError';
  }
}

/** 401 / 403 — missing / invalid / unauthorized Firebase ID token. */
export class NFeAuthError extends NFeHttpError {
  constructor(message: string, status: number, body: unknown) {
    super(message, status, body);
    this.name = 'NFeAuthError';
  }
}

/** 404 — Pedido not found in Firestore. */
export class NFePedidoNotFoundError extends NFeHttpError {
  public readonly pedidoId: string;
  constructor(pedidoId: string, body: unknown) {
    super(`Pedido not found: ${pedidoId}`, 404, body);
    this.name = 'NFePedidoNotFoundError';
    this.pedidoId = pedidoId;
  }
}

/** 409 — `bloquearEmissaoNFe` flag is set on the Pedido. */
export class NFeBlockedError extends NFeHttpError {
  public readonly pedidoId: string;
  constructor(pedidoId: string, body: unknown) {
    super(`Pedido ${pedidoId} has bloquearEmissaoNFe set`, 409, body);
    this.name = 'NFeBlockedError';
    this.pedidoId = pedidoId;
  }
}

/**
 * 409 — inutilização aborted by the pre-check: a número in the requested range
 * belongs to an already-authorized NF-e, so sending the `inutNFe` would be
 * consumo indevido. Shares the 409 status with `NFeBlockedError` but is
 * disambiguated by the body marker `code === 'INUTILIZACAO_ABORTED'`.
 */
export class NFeInutilizacaoAbortedError extends NFeHttpError {
  constructor(message: string, body: unknown) {
    super(message, 409, body);
    this.name = 'NFeInutilizacaoAbortedError';
  }
}

/**
 * 422 — SEFAZ accepted the request but REJECTED the document
 * (`estado='rejeitada'`). The full emit result is attached for
 * caller inspection (the `cStat` + `xMotivo` are the actionable
 * diagnostics). Distinct from `NFeServerError` because this is the
 * happy-path-of-an-unhappy-outcome — the orchestrator did its job
 * end-to-end; SEFAZ said no.
 */
export class NFeRejectedError extends NFeHttpError {
  public readonly cStat: string;
  public readonly xMotivo: string;
  constructor(cStat: string, xMotivo: string, body: unknown) {
    super(`SEFAZ rejected: cStat=${cStat} ${xMotivo}`, 422, body);
    this.name = 'NFeRejectedError';
    this.cStat = cStat;
    this.xMotivo = xMotivo;
  }
}

/**
 * 422 from the DANFE artifact endpoint (`GET /api/nfe/danfe`) — the NF-e is
 * **not renderable**: it never reached an authorizable estado
 * (aprovada / cancelada) or has no persisted procNFe. Distinct from
 * `NFeRejectedError`: this is a presentation precondition, not a SEFAZ
 * rejection, so it carries no `cStat` — callers must not treat it as one.
 */
export class NFeDanfeUnavailableError extends NFeHttpError {
  constructor(message: string, body: unknown) {
    super(message, 422, body);
    this.name = 'NFeDanfeUnavailableError';
  }
}

/**
 * 503 — `apps/nfe` reports `getNFeRuntime()` failed. Usually cert
 * load, cert expiry, or SEFAZ TLS chain missing. The body's `error`
 * field carries the specific reason.
 */
export class NFeRuntimeNotReadyError extends NFeHttpError {
  constructor(message: string, body: unknown) {
    super(`NF-e runtime not ready: ${message}`, 503, body);
    this.name = 'NFeRuntimeNotReadyError';
  }
}

/** 5xx other than 503 — internal `apps/nfe` failure. */
export class NFeServerError extends NFeHttpError {
  constructor(message: string, status: number, body: unknown) {
    super(message, status, body);
    this.name = 'NFeServerError';
  }
}

/**
 * Network-level failure — DNS, connection refused, timeout, abort.
 * Not an HTTP status; the request never reached `apps/nfe` (or its
 * response never arrived). Distinct from server-side errors so
 * callers can decide to retry on the client side.
 */
export class NFeNetworkError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NFeNetworkError';
    if (cause !== undefined) this.cause = cause;
  }
}
