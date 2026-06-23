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

export { ALL_DOMAINS } from './registry';

export { millisSinceEpoch, microsSinceEpoch } from './datetime';
// Re-export the epoch "now" + coercion helpers so schema consumers (e.g.
// @delfrance/storage, apps/functions) can stamp/read numeric-epoch fields without
// a direct @delfrance/core dep.
export { nowMicros, nowMillis, coerceToMicros, coerceToMillis } from '@delfrance/core/datetime';

// Canonical structural equality lives in @delfrance/core; re-exported here so the
// data layer (which depends on schemas, not core directly) can detect changes.
export { valuesEqual } from '@delfrance/core';

export { auditEntrySchema, type AuditEntry } from './audit';

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
  ESTADO_FRETE_LABELS,
  ESTADOS_FRETE_NAO_POSTADO,
  INTEGRACAO_FRETE_LABELS,
  MODALIDADE_FRETE_LABELS,
  dimensoesSchema,
  estadoFreteSchema,
  freteDoPedidoSchema,
  integracoesFreteSchema,
  isFreteJaPostado,
  modalidadeFreteSchema,
  reboqueSchema,
  transportadoraSchema,
  veiculoSchema,
  volumeSchema,
  type Dimensoes,
  type EstadoFrete,
  type FreteDoPedido,
  type IntegracaoFrete,
  type ModalidadeFrete,
  type Reboque,
  type Transportadora,
  type Veiculo,
  type Volume,
} from './frete';

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
  integracao,
  integracaoSchema,
  integracaoMeta,
  integracaoTipoSchema,
  INTEGRACAO_TIPO,
  INTEGRACAO_TIPO_LABELS,
  pluginIdForTipo,
  type Integracao,
  type IntegracaoTipo,
} from './integracao';

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
  mediaPath,
  productArquivoId,
  derivativeArquivoId,
  parseProductOriginalPath,
  isWatchedProductOriginal,
  isDerivativeName,
  firebaseDownloadUrl,
  normalizeName,
  type VariantSpec,
  type ParsedOriginalPath,
} from './storage/storagePaths';

export { buildFotoRefs, fotoSchema, type Foto, type FotoRefs } from './storage/foto';
export { videoSchema, videoFormatoSchema, type Video, type VideoFormato } from './storage/video';
