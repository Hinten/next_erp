import { z } from 'zod';

// Global pt-BR error map for every consumer of these schemas — web forms
// (zodResolver), the data-layer converters (parseForWrite/parseSoftRead),
// integrations route handlers and test fixtures all import from this barrel,
// so the config runs before any parse. Schema-level custom messages still
// take precedence; this only replaces Zod's English defaults.
z.config(z.locales.pt());

export type {
  CollectionMetadata,
  CollectionDefaultQuery,
  DefaultQueryWhere,
  DefaultQueryOrderBy,
  DefaultQueryValue,
  DomainSchema,
} from './types';

export { RECENCY_SORT } from './types';

export { ALL_DOMAINS } from './registry';

export { millisSinceEpoch, microsSinceEpoch } from './shared/datetime';

// The four LOCAL resilience fields shared by every failures-only inbound-webhook
// notification collection. Exported so a NEW channel's schema can spread the same
// block the pipeline in `@delfrance/data/admin/notifications` writes/reads blind.
export {
  notificacaoResilienciaStatusSchema,
  notificationResilienceFields,
  type NotificacaoResilienciaStatus,
} from './shared/notificationResilience';
// Re-export `nowMicros` so schema consumers (e.g. @delfrance/storage,
// apps/functions) can stamp numeric-epoch fields without a direct @delfrance/core
// dep. (The other epoch/coercion helpers are imported straight from
// @delfrance/core/datetime by their consumers — no re-export needed.)
export { nowMicros } from '@delfrance/core/datetime';

// Canonical structural equality lives in @delfrance/core; re-exported here so the
// data layer (which depends on schemas, not core directly) can detect changes.
export { valuesEqual } from '@delfrance/core';

export {
  outerRefSchema,
  idRefSchema,
  docIdSchema,
  outerRefLooseSchema,
  toOuterRef,
  idFromRef,
  parseRef,
  type OuterRef,
  type IdRef,
  type DocId,
  type OuterRefLoose,
} from './shared/outerRef';

export {
  cliente,
  clienteSchema,
  clienteFormSchema,
  clienteMeta,
  tipoClienteSchema,
  TIPO_CLIENTE_LABELS,
  refineClienteTipoDocumento,
  type Cliente,
  type TipoCliente,
} from './cliente';

export {
  endereco,
  enderecoSchema,
  enderecoMeta,
  ufSchema,
  type Endereco,
  type UF,
} from './endereco';

// All produto-owned schemas + logic live in ./produto, grouped by kind
// (collections, embedded objects, pure logic, page model). Domains produto only
// references (grupoDeVariacoes, listaDePrecos, deposito, categoria, …) stay below.
export * from './produto';

export { categoria, categoriaSchema, categoriaMeta, type Categoria } from './categoria';

export {
  ESTADO_FRETE,
  ESTADO_FRETE_LABELS,
  ESTADOS_FRETE_NAO_POSTADO,
  ESTADOS_FRETE_PRE_AUTORIZACAO,
  FREIGHT_TIPO_CAPS,
  INTEGRACAO_FRETE_LABELS,
  MODALIDADE_FRETE_LABELS,
  dimensoesSchema,
  estadoFreteSchema,
  freightCapsFor,
  freteDoPedidoSchema,
  integracoesFreteSchema,
  isFreteJaPostado,
  isFreteMarketplaceOwned,
  modalidadeFreteSchema,
  podeAutorizarDespacho,
  reboqueSchema,
  transportadoraSchema,
  veiculoSchema,
  volumeSchema,
  type Dimensoes,
  type EstadoFrete,
  type FreightLabelMode,
  type FreightTipoCapabilities,
  type FreteDoPedido,
  type IntegracaoFrete,
  type ModalidadeFrete,
  type Reboque,
  type Transportadora,
  type Veiculo,
  type Volume,
} from './shared/frete';

export {
  DIA_DA_SEMANA_LABELS,
  diaDaSemanaSchema,
  faixaCepOptionString,
  faixaDeCepSchema,
  getPrazoDespacho,
  horarioDeCorteSchema,
  intFrete,
  intFreteMeta,
  intFreteSchema,
  mapaDeIntegracoesSchema,
  tokenMelEnv,
  tokenMelEnvMeta,
  tokenMelEnvSchema,
  type DiaDaSemana,
  type FaixaDeCep,
  type HorarioDeCorte,
  type IntFrete,
  type MapaDeIntegracoes,
  type TokenMelEnv,
} from './intFrete';

// Pedido domain (pedido + pagamento + incidente + historicoEstadoPedido
// collections, the totals factory, kanban buckets, and the page model) all live
// in ./pedido, grouped by kind like ./produto.
export * from './pedido';

export {
  // `credenciaisMetodoPgto` is intentionally NOT exported as a DomainSchema and
  // NOT registered in ALL_DOMAINS — it is an admin-only, default-deny secret
  // store (mirrors `credenciaisIntegracao` / `certificadoSecreto`). Only its
  // schema/meta/type are public.
  credenciaisMetodoPgtoSchema,
  credenciaisMetodoPgtoMeta,
  type CredenciaisMetodoPgto,
} from './credenciaisMetodoPgto';

export { counter, counterSchema, counterMeta, type Counter } from './counter';

export {
  conversa,
  conversaSchema,
  conversaMeta,
  mensagem,
  mensagemSchema,
  mensagemMeta,
  origemConversaSchema,
  estadoConversaSchema,
  estadoEnvioMensagemSchema,
  tipoMensagemSchema,
  ORIGEM_LABELS,
  ESTADO_CONVERSA,
  ESTADO_CONVERSA_LABELS,
  ESTADO_ENVIO,
  ESTADO_ENVIO_LABELS,
  TIPO_MENSAGEM_LABELS,
  podeReabrirConversa,
  type Conversa,
  type Mensagem,
  type OrigemConversa,
  type EstadoConversa,
  type EstadoEnvioMensagem,
  type TipoMensagem,
} from './conversa';

export {
  ORIGEM_RULES,
  WHATSAPP_ANEXO_LIMITS,
  type OrigemRule,
  type WhatsappAnexoTipo,
} from './conversaOrigem';

export {
  integracao,
  integracaoSchema,
  integracaoMeta,
  integracaoTipoSchema,
  INTEGRACAO_TIPO,
  INTEGRACAO_TIPO_LABELS,
  pluginIdForTipo,
  // Shopee brand cache subcollection — a real DomainSchema, registered in
  // ALL_DOMAINS, reusing the parent `integracao` permission bits.
  brandShopee,
  brandShopeeSchema,
  brandShopeeMeta,
  // WhatsApp weekly business-hours building blocks, used by `integracaoSchema`'s
  // `horario_funcionamento` field.
  horarioWhatsappSchema,
  periodoWhatsappSchema,
  // Legacy-exact codec for `Horario_Whatsapp.abertura`/`.fechamento` — the
  // business-hours editor (#528) and the #529 `estaAberto` port MUST use these
  // (never re-derive the ms by hand); byte-compatible with the Flutter wire.
  encodeHorarioMs,
  decodeHorarioMs,
  // `credenciaisIntegracao` is intentionally NOT exported as a DomainSchema and
  // NOT registered in ALL_DOMAINS — it is an admin-only, default-deny secret
  // store (mirrors `certificadoSecreto`). Only its schema/meta/type are public.
  credenciaisIntegracaoSchema,
  credenciaisIntegracaoMeta,
  // `tokenDuravel` is likewise admin-only / default-deny (Mercado Livre durable
  // credential in the old Flutter wire shape, shared during dual-run) — not a
  // DomainSchema, not in ALL_DOMAINS; only its schema/meta/type are public.
  tokenDuravelSchema,
  tokenDuravelMeta,
  // `credenciaisWhatsapp` mirrors `credenciaisIntegracao`: admin-only,
  // default-deny WhatsApp permanent-token store — not a DomainSchema, not in
  // ALL_DOMAINS; only its schema/meta/type are public.
  credenciaisWhatsappSchema,
  credenciaisWhatsappMeta,
  type Integracao,
  type IntegracaoTipo,
  type BrandShopee,
  type HorarioWhatsapp,
  type PeriodoWhatsapp,
  type CredenciaisIntegracao,
  type TokenDuravel,
  type CredenciaisWhatsapp,
} from './integracao';

export {
  // Admin-only / default-deny (NOT in ALL_DOMAINS) — the inbound webhook log.
  notificacaoStatusSchema,
  notificacaoMercadoLivreSchema,
  notificacaoResourceId,
  type NotificacaoStatus,
  type NotificacaoMercadoLivre,
} from './notificacaoMercadoLivre';

export {
  // Admin-only / default-deny (NOT in ALL_DOMAINS) — the inbound webhook log,
  // mirrors notificacaoMercadoLivre above (#531).
  notificacaoMercadoPagoStatusSchema,
  notificacaoMercadoPagoSchema,
  type NotificacaoMercadoPagoStatus,
  type NotificacaoMercadoPago,
} from './notificacaoMercadoPago';

export {
  // Admin-only / default-deny (NOT in ALL_DOMAINS) — the "Importar todos os
  // anúncios" mass-import job/checkpoint doc (#621).
  importacaoMercadoLivreStatusSchema,
  massImportOptionsSchema,
  massImportFailureSchema,
  importacaoMercadoLivreSchema,
  type ImportacaoMercadoLivreStatus,
  type MassImportOptions,
  type MassImportFailure,
  type ImportacaoMercadoLivre,
} from './importacaoMercadoLivre';

export {
  // Admin-only / default-deny (NOT in ALL_DOMAINS) — the per-conta durable
  // cursor doc for the flag-gated order-backfill sweep (#360, Step 9 PR 4).
  // Bare schema+meta (perms 0n), not a DomainSchema — see the NOTE at the
  // bottom of backfillPedidosMercadoLivre.ts.
  backfillPedidosMercadoLivreSchema,
  backfillPedidosMercadoLivreMeta,
  type BackfillPedidosMercadoLivre,
} from './backfillPedidosMercadoLivre';

export {
  // Admin-only / default-deny (NOT in ALL_DOMAINS) — the per-conta durable
  // state doc for the flag-gated ML stock-sync sweeps (Step 10). Bare
  // schema+meta (perms 0n), not a DomainSchema — see the NOTE at the bottom
  // of estoqueMercadoLivreSync.ts.
  estoqueMercadoLivreSyncSchema,
  estoqueMercadoLivreSyncMeta,
  type EstoqueMercadoLivreSync,
} from './estoqueMercadoLivreSync';

export {
  // Admin-only / default-deny (NOT in ALL_DOMAINS) — the persisted round-robin
  // cursor for the unreferenced-arquivo sweep (#234). Bare schema+meta
  // (perms 0n), not a DomainSchema — see the NOTE at the bottom of
  // arquivoOrphanSweepState.ts.
  ARQUIVO_ORPHAN_SWEEP_STATE_DOC_ID,
  arquivoOrphanSweepStateSchema,
  arquivoOrphanSweepStateMeta,
  type ArquivoOrphanSweepState,
} from './arquivoOrphanSweepState';

export {
  // Admin-only / default-deny (NOT in ALL_DOMAINS) — the inbound webhook log,
  // mirrors notificacaoMercadoPago above (#527). Bare schema+meta (perms 0n),
  // not a DomainSchema — see the NOTE at the bottom of notificacoesWhatsapp.ts.
  notificacoesWhatsappStatusSchema,
  notificacoesWhatsappSchema,
  notificacoesWhatsappMeta,
  type NotificacoesWhatsappStatus,
  type NotificacoesWhatsapp,
} from './notificacoesWhatsapp';

export {
  cargo,
  cargoSchema,
  cargoMeta,
  decodePermissoes,
  encodePermissoes,
  type Cargo,
} from './cargo';

export {
  usuario,
  usuarioSchema,
  usuarioMeta,
  aggregatePermissoes,
  isSuperUserBits,
  SUPERUSER_MASK,
  type Usuario,
} from './usuario';

export { deposito, depositoSchema, depositoMeta, type Deposito } from './deposito';

export {
  grupoDeVariacoes,
  grupoDeVariacoesSchema,
  grupoDeVariacoesMeta,
  varianteSchema,
  externalVariacaoLinkSchema,
  tipoVariacaoSchema,
  TIPO_VARIACAO,
  TIPO_VARIACAO_LABELS,
  type GrupoDeVariacoes,
  type Variante,
  type ExternalVariacaoLink,
  type TipoVariacao,
} from './grupoDeVariacoes';

export {
  tabelaDeMedidas,
  tabelaDeMedidasSchema,
  tabelaDeMedidasMeta,
  type TabelaDeMedidas,
} from './tabelaDeMedidas';

export {
  mlSizeChartRowSchema,
  mlSizeChartSchema,
  mlSizeChartWriteSchema,
  mlSizeChartsForContaSchema,
  mlSizeChartsForConta,
  type MlSizeChart,
  type MlSizeChartRow,
} from './tabelaDeMedidasMercadoLivre';

export {
  listaDePrecos,
  listaDePrecosSchema,
  listaDePrecosMeta,
  formulaCalculoPrecoSchema,
  formulasPorCategoriaSchema,
  faixaTaxaFixaPesoSchema,
  type ListaDePrecos,
  type FormulaCalculoPreco,
  type FormulasPorCategoria,
  type FaixaTaxaFixaPeso,
} from './listaDePrecos';

export {
  operacao,
  operacaoSchema,
  operacaoMeta,
  tipoNFeSchema,
  finNFeOperacaoSchema,
  indPresOperacaoSchema,
  indIntermedOperacaoSchema,
  origemProdutoImpostoSchema,
  TIPO_NFE,
  TIPO_NFE_LABELS,
  FIN_NFE_OPERACAO_LABELS,
  IND_PRES_OPERACAO_LABELS,
  IND_INTERMED_OPERACAO_LABELS,
  type Operacao,
  type TipoNFe,
  type FinNFeOperacao,
  type IndPresOperacao,
  type IndIntermedOperacao,
  type OrigemProdutoImposto,
} from './operacao';

export {
  motivoIncidente,
  motivoIncidenteSchema,
  motivoIncidenteMeta,
  type MotivoIncidente,
} from './motivoIncidente';

export { filial, filialSchema, filialMeta, type Filial } from './filial';

export {
  certificadoSecretoSchema,
  certificadoSecretoMeta,
  certificadoFilialInfoSchema,
  encryptedBlobSchema,
  CERTIFICADO_SECRETO_PATH,
  CERTIFICADO_SECRETO_DOC_ID,
  type CertificadoSecreto,
  type CertificadoFilialInfo,
  type EncryptedBlob,
} from './certificadoFilial';

export {
  bandeiraCartao,
  bandeiraCartaoSchema,
  bandeiraCartaoMeta,
  bandeiraSchema,
  BANDEIRA,
  BANDEIRA_LABELS,
  type BandeiraCartao,
  type Bandeira,
} from './bandeiraCartao';

export {
  nfe,
  nfeSchema,
  nfeMeta,
  estadoNFeSchema,
  ESTADO_NFE,
  ESTADO_NFE_LABELS,
  ESTADOS_FINAIS_NFE,
  isEstadoFinalNFe,
  CHAVE_NFE_REGEX,
  type NotaFiscalEletronica,
  type EstadoNFe,
} from './nfe';

export {
  nfeConfig,
  nfeConfigSchema,
  nfeConfigMeta,
  ambienteNFEschema,
  contingenciaModoSchema,
  type NFeConfig,
  type AmbienteNFE,
  type ContingenciaModo,
} from './nfeConfig';

export {
  enviNfeMsg,
  enviNfeMsgSchema,
  enviNfeMsgMeta,
  estadoEnviNFeMsgSchema,
  ESTADO_ENVI_NFE_MSG,
  type EnviNFeMsg,
  type EstadoEnviNFeMsg,
} from './enviNfeMsg';

export {
  inutNumeracao,
  inutNumeracaoSchema,
  inutNumeracaoMeta,
  type InutNumeracao,
} from './inutilizacaoNumeracao';

export {
  cartaCorrecao,
  cartaCorrecaoSchema,
  cartaCorrecaoMeta,
  type CartaCorrecao,
} from './cartaCorrecao';

export {
  impostoProduto,
  impostoProdutoSchema,
  impostoProdutoMeta,
  operacaoIdFromImpostoRef,
  ORIGEM_PRODUTO_LABELS,
  type ImpostoProduto,
} from './impostoProduto';

export {
  impostoCategoria,
  impostoCategoriaSchema,
  impostoCategoriaMeta,
  type ImpostoCategoria,
} from './impostoCategoria';

export {
  regraImposto,
  regraImpostoSchema,
  regraImpostoMeta,
  type RegraImposto,
} from './regraImposto';

// Tributary config schemas (ICMS/IPI/PIS/COFINS/ISSQN/retenção + RTC IBS/CBS/IS).
// Single source of truth, browser-safe; the NF-e tribute engine re-exports them.
export {
  // enums
  crtSchema,
  csosnSchema,
  cstSchema,
  modBCSchema,
  modBCSTSchema,
  motDesICMSSchema,
  origemSchema,
  cstPisCofinsSchema,
  cstIpiSchema,
  indISSSchema,
  indIncentivoSchema,
  IPI_TRIB_CSTS,
  // ICMS sub-configs (SN + Regime Normal)
  confICMSSN101Schema,
  confICMSSN201Schema,
  confICMSSN202ou203Schema,
  confICMSSN500Schema,
  confICMSSN900Schema,
  confICMS00Schema,
  confICMS10Schema,
  confICMS20Schema,
  confICMS30Schema,
  confICMS404150Schema,
  confICMS51Schema,
  confICMS60Schema,
  confICMS70Schema,
  confICMS90Schema,
  configuracaoICMSSchema,
  // PIS / COFINS / IPI / ISSQN / retenção
  confPISSchema,
  confCOFINSSchema,
  configuracaoPISSTSchema,
  configuracaoIPISchema,
  configuracaoISSQNSchema,
  retencaoSchema,
  // RTC (IBS/CBS/IS)
  configuracaoISRtcSchema,
  configuracaoIBSCBSSchema,
  // canonical per-item Imposto
  impostoSchema,
  normalizeNCM,
  // label maps
  CRT_LABELS,
  CSOSN_LABELS,
  CST_ICMS_LABELS,
  MOD_BC_LABELS,
  MOD_BCST_LABELS,
  MOT_DES_ICMS_LABELS,
  CST_PIS_COFINS_LABELS,
  CST_IPI_LABELS,
  IND_ISS_LABELS,
  IND_INCENTIVO_LABELS,
  // types
  type Crt,
  type Csosn,
  type Cst,
  type ModBC,
  type ModBCST,
  type MotDesICMS,
  type Origem,
  type CstPisCofins,
  type CstIpi,
  type IndISS,
  type IndIncentivo,
  type ConfICMSSN101,
  type ConfICMSSN201,
  type ConfICMSSN202ou203,
  type ConfICMSSN500,
  type ConfICMSSN900,
  type ConfICMS00,
  type ConfICMS10,
  type ConfICMS20,
  type ConfICMS30,
  type ConfICMS404150,
  type ConfICMS51,
  type ConfICMS60,
  type ConfICMS70,
  type ConfICMS90,
  type ConfiguracaoICMS,
  type ConfPIS,
  type ConfCOFINS,
  type ConfiguracaoPISST,
  type ConfiguracaoIPI,
  type ConfiguracaoISSQN,
  type Retencao,
  type ConfiguracaoISRtc,
  type ConfiguracaoIBSCBS,
  type Imposto,
} from './imposto/tribute';

export {
  // RTC cClassTrib/CST seed + validator (#333)
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
} from './imposto/cclasstrib';

export {
  arquivo,
  arquivoSchema,
  arquivoMeta,
  filetypeSchema,
  filetypeFromMime,
  normalizeContentType,
  externalIdSchema,
  FILETYPE,
  ARQUIVOS_COLLECTION,
  type Arquivo,
  type Filetype,
  type ExternalId,
} from './storage/arquivo';

export {
  STORAGE_ROOT,
  PRODUTO_SUBDIR,
  PRODUCT_IMAGE_VARIANTS,
  DERIVATIVE_EXT,
  productOriginalPath,
  productDerivativePath,
  productVideoPath,
  productAnexoPath,
  mediaPath,
  tabMediOriginalPath,
  productArquivoId,
  tabMediArquivoId,
  derivativeArquivoId,
  parseProductOriginalPath,
  isWatchedProductOriginal,
  parseProductMediaDir,
  parseOwnedMediaDir,
  isDerivativeName,
  firebaseDownloadUrl,
  normalizeName,
  type VariantSpec,
  type ParsedOriginalPath,
  type ProductMediaKind,
  type ParsedProductMediaDir,
  type MediaOwnerCollection,
  type ParsedOwnedMediaDir,
} from './storage/storagePaths';

export {
  buildFotoRefs,
  buildOriginalFotoRef,
  deriveFotosArquivosIds,
  fotoSchema,
  type Foto,
  type FotoRefs,
} from './storage/foto';
export { videoSchema, videoFormatoSchema, type Video, type VideoFormato } from './storage/video';
