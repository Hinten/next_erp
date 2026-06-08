/**
 * HTTP client for `apps/nfe` — browser- and Node-callable.
 * The library's public entry for any caller that needs to issue
 * NF-es via the orchestrator host without importing the heavy
 * server-only modules (cert, sign, soap, …).
 */
export {
  createNFeHttpClient,
  isNFeEmitError,
  type NFeBatchEmitResult,
  type NFeCartaCorrecaoResult,
  type NFeConsultaResult,
  type NFeDanfeArtifact,
  type NFeDanfeFormat,
  type NFeEmitError,
  type NFeEmitResult,
  type NFeHttpClient,
  type NFeHttpClientConfig,
  type NFeInutilizarArgs,
  type NFeInutilizarResult,
  type NFeProcessarPendentesResult,
} from './client';

export {
  NFeAuthError,
  NFeBadRequestError,
  NFeBlockedError,
  NFeDanfeUnavailableError,
  NFeHttpError,
  NFeInutilizacaoAbortedError,
  NFeNetworkError,
  NFePedidoNotFoundError,
  NFeRejectedError,
  NFeRuntimeNotReadyError,
  NFeServerError,
} from './errors';
