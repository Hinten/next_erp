/**
 * `@delfrance/integrations-nfe` — public surface.
 *
 * Re-exports the typed entry points + the building blocks the
 * orchestrator (`apps/nfe`) needs. Server-only modules
 * (cert, sign, soap, xsd, safety, xml) ship from this same entry today;
 * a `./server` subpath will split them out once a browser-bundle consumer
 * appears (which it won't in `apps/web` — that app only talks to
 * `apps/nfe` over HTTP, never imports the library directly).
 */
import type { InvoiceProvider } from '@delfrance/core/plugins';

// Cert
export {
  NFeCertError,
  assertCertNotExpired,
  isCertExpired,
  loadCertificateFromBase64,
  loadCertificateFromEnv,
  loadCertificateFromPath,
  warnIfCertNearExpiry,
  type NFeCertificate,
} from './cert';

// Endpoints
export {
  NFeEndpointError,
  getEndpoints,
  supportedUFs,
  type Ambiente,
  type NfeServiceUrls,
} from './endpoints';

// XML (de)serializer
export {
  NFeXmlError,
  parse,
  serialize,
  serializeFragment,
  type XmlValue,
} from './xml';

// Sanitization
export {
  removerAcentos,
  removerCharRestrito,
  sanitizeNFeEmail,
  sanitizeNFeText,
} from './sanitize';

// State machine
export {
  MAX_LOTE_POLL_RETRIES,
  applyOutcome,
  classifyCStat,
  cStatToEstado,
  nextAction,
  type CStatCategory,
  type NextAction,
  type NFeStatePatch,
  type SefazOutcome,
} from './state';

// Sign
export {
  NFeSignatureError,
  signEvento,
  signInutilizacao,
  signNFe,
} from './sign';

// SOAP transport (low-level — most callers reach for src/operations)
export {
  NFeTransportError,
  createSefazAgent,
  nfeAutorizacaoLote,
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
export {
  NFeProductionGuardError,
  assertSafeTpAmb,
  tpAmbFromAmbiente,
  type TpAmb,
} from './safety';

// Generator
export {
  NFeChaveError,
  NFeGeneratorError,
  NFeIdeError,
  generateNFe,
  type GeneratorInput,
  type GeneratorItem,
  type GeneratorOutput,
  type TpEmis,
} from './generator';

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
  consultarLote,
  consultarSituacaoNFe,
  consultarStatusServico,
  type CUFCode,
} from './operations';

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

// Legacy InvoiceProvider stub — kept until apps/nfe is deployed and the
// real HTTP-backed provider replaces it (A9 second half).
export interface NFeConfig {
  ambiente: 'producao' | 'homologacao';
  uf: string;
  certPath?: string;
  certPasswordEnvVar?: string;
}

export class NFeNotConfiguredError extends Error {
  constructor() {
    super('NFe plugin not configured. Spike outcomes pending — see ADR 0004–0008.');
    this.name = 'NFeNotConfiguredError';
  }
}

export function createNFeProvider(_config: NFeConfig): InvoiceProvider {
  return {
    id: 'nfe',
    issue: async (_orderId: string) => {
      throw new NFeNotConfiguredError();
    },
  };
}
