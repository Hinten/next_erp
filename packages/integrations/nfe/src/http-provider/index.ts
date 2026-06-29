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
  type NFeCertificadoMeta,
  type NFeConsultaCadastroInfCad,
  type NFeConsultaCadastroResult,
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
  type NFeStatusServicoResult,
} from './client';

export {
  NFeAuthError,
  isRetryableNFeHttpError,
  NFeBadRequestError,
  NFeBlockedError,
  NFeCertificateError,
  NFeDanfeUnavailableError,
  NFeHttpError,
  NFeInutilizacaoAbortedError,
  NFeNetworkError,
  NFePedidoNotFoundError,
  NFeRejectedError,
  NFeRuntimeNotReadyError,
  NFeServerError,
} from './errors';

// RTC IBS/CBS code tables + validator — a **pure, zero-dep** module
// (`../tribute/cclasstrib`), safe to surface in the browser bundle so the
// produto Impostos picker shares the emit-time engine's source of truth.
export {
  CCLASSTRIB_SEED,
  CST_IBSCBS_CODES,
  CST_IBSCBS_LABELS,
  cClassTribCodesForCst,
  cClassTribDescricao,
  cClassTribEntriesForCst,
  cstClassTribStructurallyValid,
  validateCstClassTrib,
  type CClassTribEntry,
  type CstClassTribValidation,
} from '../tribute/cclasstrib';
