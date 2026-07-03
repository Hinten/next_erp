/**
 * `@delfrance/integrations-nfe` — public surface.
 *
 * **Server kitchen sink.** Re-exports cert / sign / soap / xsd /
 * safety / xml / generator / operations / tribute / numeracao /
 * recovery / state / http-provider — everything the orchestrator
 * (`apps/nfe`) needs to issue NF-es from Node. **Do not import
 * this entry from a browser bundle** — the soap + cert modules
 * pull `node:fs` and `node-forge` which Turbopack cannot ship to
 * the browser.
 *
 * Browser consumers (currently only `apps/web`) import the
 * `./http-provider` subpath instead — declared in `package.json`'s
 * `exports` field and re-exported by `src/http-provider/index.ts`.
 * That subpath carries only the typed HTTP client + error classes
 * and has zero server-only deps in its transitive graph. See
 * `CLAUDE.md` ("Subpath exports") for the upgrade playbook when
 * adding new browser-safe surfaces.
 */
import type { InvoiceProvider } from '@delfrance/core/plugins';

// Cert
export {
  NFeCertError,
  assertCertNotExpired,
  buildCertFromStored,
  decryptSecret,
  encryptSecret,
  getCertEncryptionKey,
  hasNFeCertEnv,
  isCertExpired,
  loadCertificateFromBase64,
  loadCertificateFromEnv,
  warnIfCertNearExpiry,
  type EncryptedBlob,
  type NFeCertificate,
} from './cert';

// Endpoints
export {
  NFeContingencyEndpointError,
  NFeEndpointError,
  getAnEndpoints,
  getConsultaCadastroEndpoint,
  getEndpoints,
  getSvcEndpoints,
  supportedUFs,
  svcAuthorizerForUF,
  type Ambiente,
  type AnServiceUrls,
  type ContingencyAuthorizer,
  type NfeServiceUrls,
  type SvcServiceUrls,
} from './endpoints';

// XML (de)serializer
export { NFeXmlError, parse, serialize, serializeFragment, type XmlValue } from './xml';

// Sanitization
export { removerAcentos, removerCharRestrito, sanitizeNFeEmail, sanitizeNFeText } from './sanitize';

// State machine
export {
  CONSUMO_INDEVIDO_MARKER,
  MAX_LOTE_POLL_RETRIES,
  MAX_RECONCILE_ATTEMPTS,
  RECONCILE_BASE_DELAY_MS,
  RECONCILE_MAX_DELAY_MS,
  RECONCILE_SWEEP_GRACE_MS,
  NFeConsumoIndevidoError,
  STATUS_BLOQUEADORES,
  applyOutcome,
  assertNotConsumoIndevido,
  classifyCStat,
  cStatToEstado,
  isBloqueada,
  nextAction,
  nextConsultaDelayMs,
  resolveTpEmis,
  CSTAT_EPEC_DUPLICIDADE,
  CSTAT_EPEC_NAO_SINCRONIZADO,
  EPEC_EVENT_REGISTRADO,
  type ContingenciaMode,
  type CStatCategory,
  type NextAction,
  type NFeStatePatch,
  type SefazOutcome,
} from './state';

// Sign
export { NFeSignatureError, signEvento, signInutilizacao, signNFe } from './sign';

// SOAP transport (low-level — most callers reach for src/operations)
export {
  NFeTransportError,
  createSefazAgent,
  nfeAutorizacaoLote,
  nfeConsultaCadastro,
  nfeConsultaProtocolo,
  nfeRetAutorizacao,
  nfeStatusServico,
  type PostResult,
  type SefazAgentOptions,
  type SefazCall,
  type SoapOperation,
} from './soap';

// XSD validation
export {
  NFeXsdValidationError,
  supportedRoots,
  validateXsd,
  type XsdError,
  type XsdRootKey,
} from './xsd';

// Safety guard
export { NFeProductionGuardError, assertSafeTpAmb, tpAmbFromAmbiente, type TpAmb } from './safety';

// Generator
export {
  NFeChaveError,
  NFeGeneratorError,
  NFeIdeError,
  NFeTzError,
  cUFFromUF,
  datePartsInOffset,
  extractCNFFromChave,
  generateNFe,
  offsetForCUF,
  offsetForUF,
  type GeneratorInput,
  type GeneratorItem,
  type GeneratorOutput,
  type TpEmis,
} from './generator';

// `<nfeProc>` envelope — post-emission stitching of signed NFe + protNFe.
export { buildNFeProc } from './nfeproc';

// Eventos (cancelamento + CC-e + EPEC) — builders for the RecepcaoEvento lote.
export {
  buildCancelamentoEvento,
  buildCCeDetEvento,
  buildCCeEvento,
  buildEnvEvento,
  buildEpecDetEvento,
  buildEpecEvento,
  buildProcEventoNFe,
  extractEpecInputFromNFe,
  C_ORGAO_AMBIENTE_NACIONAL,
  NFeEventoError,
  TP_EVENTO_CANCELAMENTO,
  TP_EVENTO_CCE,
  TP_EVENTO_EPEC,
  XCONDUSO_CCE,
  type CancelamentoEventoInput,
  type CCeEventoInput,
  type EpecEventoInput,
} from './eventos';

// Inutilização de numeração — builder for the NfeInutilizacao lote.
export { buildInutNFe, NFeInutilizacaoError, type InutilizacaoInput } from './inutilizacao';

// Recovery / anti-loss
export {
  DEFAULT_STUCK_TIMEOUT_MS,
  RE_CHNFE,
  RE_NREC,
  classifyRecovery,
  extractMarkers,
  isStuckEnviando,
  outcomeFromInfProt,
  outcomeFromRetConsRec,
  outcomeFromRetConsSit,
  outcomeFromRetEnviNFe,
  type MaybeStuckNFe,
  type RecoveryKind,
} from './recovery';

// Typed operations (the default API for app code)
export {
  autorizarLote,
  cancelarNFe,
  cartaCorrecaoNFe,
  consultarCadastro,
  consultarLote,
  consultarSituacaoNFe,
  consultarStatusServico,
  enviarEpec,
  inutilizarNumeracao,
  type CancelarNFeResult,
  type CartaCorrecaoResult,
  type ConsultaCadastroEnder,
  type ConsultaCadastroInfCad,
  type ConsultaCadastroResult,
  type CUFCode,
  type EpecResult,
  type InutilizarResult,
} from './operations';

// Re-export the SOAP response types that orchestrator-level code uses
// in function signatures. Other typed responses (TRetConsSitNFe etc.)
// are reachable through `NFeSchemas` (codegen'd Zod) and the function
// return types, but `TRetEnviNFe['protNFe']` shows up enough that
// pulling it from the package root keeps call sites tidy.
export type {
  TRetConsReciNFe,
  TRetConsSitNFe,
  TRetConsStatServ,
  TRetEnviNFe,
} from './types/nfe-schema';

// Generated Zod schemas (one per SEFAZ complexType, plus ROOTS_SCHEMAS).
// Re-exported as a namespace so callers can pull individual schemas by name
// without polluting the top-level surface with 160+ symbols. Use as:
//   import { NFeSchemas } from '@delfrance/integrations-nfe';
//   const validated = NFeSchemas.TNFe_infNFe_det_impostoSchema.parse(input);
export * as NFeSchemas from './types/nfe-schema-zod';

// Per-Filial numeração + lote counters. Library functions over an
// injectable NFeConfigStore; the firebase-admin-backed adapter ships
// from `./numeracao/firestore-adapter` so apps/nfe can wire its
// Firestore instance through without the library taking a hard
// dep on firebase-admin.
export {
  NFeBulkSizeError,
  NFeConfigNotFoundError,
  nextIdLote,
  nextNumeracao,
  nextNumeracaoBulk,
  readNFeConfig,
  type NFeConfigStore,
  type NFeConfigTx,
} from './numeracao';
export {
  DEFAULT_NFE_CONFIG_DOC_ID,
  nfeConfigStoreFromFirestore,
  type AdminDocRefLike,
  type AdminFirestoreLike,
  type AdminTxLike,
} from './numeracao/firestore-adapter';

// Simples Nacional tributary engine — per-item <imposto> dispatch,
// <total> aggregation, <transp> / <pag> builders. The orchestrator in
// apps/nfe consumes these to build the SEFAZ wire shape from Flutter-
// stamped Imposto rules.
export {
  NFeTributeError,
  TributeFormatError,
  aggregateTotals,
  buildImpostoXml,
  buildPagXml,
  buildTotalXml,
  buildTranspXml,
  configuracaoICMSSchema,
  confCOFINSSchema,
  confPISSchema,
  crtSchema,
  csosnSchema,
  impostoSchema,
  modBCSchema,
  modBCSTSchema,
  origemSchema,
  paymentSchema,
  tPagSchema,
  tributeItemSchema,
  type ConfCOFINS,
  type ConfPIS,
  type ConfiguracaoICMS,
  type Crt,
  type Csosn,
  type Imposto,
  type ModBC,
  type ModBCST,
  type ModFrete,
  type Origem,
  type Payment,
  type TPag,
  type TotalAggregation,
  type TributeItem,
} from './tribute';

// HTTP client + typed errors for callers (`apps/web`) that talk to
// `apps/nfe` over HTTP. See `src/http-provider/` for the full surface.
export {
  NFeAuthError,
  NFeBadRequestError,
  NFeBlockedError,
  NFeHttpError,
  NFeNetworkError,
  NFePedidoNotFoundError,
  NFeRejectedError,
  NFeRuntimeNotReadyError,
  NFeServerError,
  createNFeHttpClient,
  type NFeCartaCorrecaoResult,
  type NFeConsultaCadastroInfCad,
  type NFeConsultaCadastroResult,
  type NFeConsultaResult,
  type NFeEmitResult,
  type NFeHttpClient,
  type NFeHttpClientConfig,
  type NFeInutilizarArgs,
  type NFeInutilizarResult,
  type NFeProcessarPendentesResult,
} from './http-provider';

import { ESTADO_NFE } from '@delfrance/schemas';

import { NFeRejectedError, createNFeHttpClient } from './http-provider';
import type { NFeHttpClientConfig } from './http-provider';

/**
 * Adapter that bridges the HTTP client to the legacy
 * `InvoiceProvider` contract (`packages/core/src/plugins/index.ts`).
 * `apps/web` registers this in the PluginRegistry; the rest of the
 * web app stays plugin-agnostic.
 *
 * Estado → InvoiceProvider status mapping:
 *   - `aprovada` → `'authorized'` (cStat=100, document is valid)
 *   - `enviando` / `aguardandoResposta` → `'pending'` (lote in flight)
 *   - `rejeitada` → `'rejected'` (cStat that maps to fiscal rejection)
 *   - anything else → `'pending'` (defensive — caller should re-query)
 */
export function createNFeProvider(config: NFeHttpClientConfig): InvoiceProvider {
  const client = createNFeHttpClient(config);
  return {
    id: 'nfe',
    issue: async (orderId: string) => {
      try {
        const result = await client.emitir(orderId);
        if (result.estado === ESTADO_NFE.aprovada) {
          return { status: 'authorized', protocol: result.nRec ?? undefined };
        }
        if (result.estado === ESTADO_NFE.rejeitada) {
          return { status: 'rejected' };
        }
        return { status: 'pending', protocol: result.nRec ?? undefined };
      } catch (err) {
        // 422 (NFeRejectedError) is a fiscal outcome, not an error from
        // the InvoiceProvider's perspective — surface it as 'rejected'.
        if (err instanceof NFeRejectedError) {
          return { status: 'rejected' };
        }
        // Auth / runtime / network errors propagate; callers handle.
        throw err;
      }
    },
  };
}
