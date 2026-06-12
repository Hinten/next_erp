/**
 * Frete (shipping) schemas — ported from the legacy Flutter ERP at
 * `.old/packages/integracao_frete/lib/src/integracao_frete_base.dart`
 * and `.old/packages/pedido/lib/src/models.dart` (the
 * `FreteDoPedido` class and its nested types Transportadora,
 * Veiculo, Reboque, Volume).
 *
 * Convention recap (matches `pedido.ts`):
 *   - All Dart `DateTime?` fields are serialized to Firestore as
 *     `int` (milliseconds since epoch). The Zod types here use
 *     `z.number().int().nullable()` to match.
 *   - Enums serialize by their `.value` (a string), not the enum
 *     name itself. For `modalidadeFrete` the values are the
 *     single-digit codes the NFe XSD uses ('0'..'9'); for
 *     `INTEGRACOES_FRETE` they're the integration slugs (amazon →
 *     'amz', etc.).
 *   - Nested entity classes (Transportadora, Veiculo, Reboque,
 *     Volume) use `.passthrough()` for the fields the Flutter app
 *     writes that we haven't enumerated yet.
 */
import { z } from 'zod';
import { ufSchema } from './endereco';

/* -------------------------------------------------------------------------- */
/*                            ESTADOS_FRETE enum                              */
/* -------------------------------------------------------------------------- */

/**
 * ESTADOS_FRETE — shipping lifecycle states. 27 values, mirroring the
 * Dart `ESTADOS_FRETE` enum (lines 105-133 of `integracao_frete_base.dart`).
 * Stored on disk as the enum's `.value` (same as the Dart name).
 */
export const ESTADO_FRETE_LABELS = {
  fulfillment: 'Fulfillment',
  iniciado: 'Iniciado',
  aguardandoAutorizacao: 'Aguardando autorização',
  aguardandoNFe: 'Aguardando NFe',
  aguardandoValidacaoTransporadora: 'Aguardando validação da transportadora',
  despachoAutorizado: 'Despacho autorizado',
  aguardandoAgendamento: 'Aguardando agendamento',
  despachoNegado: 'Despacho negado',
  emSeparacao: 'Em separação',
  empacotado: 'Empacotado',
  aguardandoPostagem: 'Aguardando postagem',
  checkFinalizado: 'Check finalizado',
  postado: 'Postado',
  recebidoPelaTransportadora: 'Recebido pela transportadora',
  aCaminho: 'A caminho do cliente',
  tentandoRealizarEntrega: 'Tentando realizar entrega',
  entregue: 'Entregue',
  falhaNaEntrega: 'Falha na entrega',
  suspenso: 'Suspenso',
  enderecoNaoEncontrado: 'Endereço não encontrado',
  aCaminhoDoRemetente: 'Ao remetente',
  devolvido: 'Devolvido ao remetente',
  objetoExtraviado: 'Objeto extraviado',
  cancelado: 'Cancelado',
  desconhecido: 'Desconhecido',
  error: 'Erro',
  aguardandoRetirada: 'Aguardando retirada',
} as const;

export const estadoFreteSchema = z
  .enum([
    'fulfillment',
    'iniciado',
    'aguardandoAutorizacao',
    'aguardandoNFe',
    'aguardandoValidacaoTransporadora',
    'despachoAutorizado',
    'aguardandoAgendamento',
    'despachoNegado',
    'emSeparacao',
    'empacotado',
    'aguardandoPostagem',
    'checkFinalizado',
    'postado',
    'recebidoPelaTransportadora',
    'aCaminho',
    'tentandoRealizarEntrega',
    'entregue',
    'falhaNaEntrega',
    'suspenso',
    'enderecoNaoEncontrado',
    'aCaminhoDoRemetente',
    'devolvido',
    'objetoExtraviado',
    'cancelado',
    'desconhecido',
    'error',
    'aguardandoRetirada',
  ])
  .meta({ labels: ESTADO_FRETE_LABELS });
export type EstadoFrete = z.infer<typeof estadoFreteSchema>;

/* -------------------------------------------------------------------------- */
/*                         modalidadeFrete enum (modFrete)                    */
/* -------------------------------------------------------------------------- */

/**
 * `modalidadeFrete` — maps 1:1 to the SEFAZ NFe XSD `modFrete` codes.
 * Values are the digit strings (`'0'`..`'9'`) Flutter writes, not the
 * enum names. See `.old/packages/canal_de_vendas/lib/src/models.dart:17`.
 */
export const MODALIDADE_FRETE_LABELS = {
  '0': 'Contratação por conta do Emitente (CIF)',
  '1': 'Contratação por conta do Destinatário (FOB)',
  '2': 'Contratação por conta de Terceiros',
  '3': 'Transporte próprio por conta do Remetente',
  '4': 'Transporte próprio por conta do Destinatário',
  '9': 'Sem ocorrência de transporte',
} as const;

export const modalidadeFreteSchema = z
  .enum(['0', '1', '2', '3', '4', '9'])
  .meta({ labels: MODALIDADE_FRETE_LABELS });
export type ModalidadeFrete = z.infer<typeof modalidadeFreteSchema>;

/* -------------------------------------------------------------------------- */
/*                         INTEGRACOES_FRETE enum                             */
/* -------------------------------------------------------------------------- */

/**
 * Shipping integration slugs. Note `amazon → 'amz'` — the on-disk value
 * differs from the enum name. Mirrors
 * `.old/packages/integracao_frete/lib/src/integracao_frete_base.dart:15`.
 */
export const INTEGRACAO_FRETE_LABELS = {
  mercadoLivre: 'Mercado Livre',
  lojaIntegrada: 'Loja Integrada',
  melhorEnvios: 'Melhor Envios',
  amz: 'Amazon',
  magalu: 'Magalu',
  retiradaNaLoja: 'Retirar na Loja',
  shopee: 'Shopee',
  motoboy: 'Motoboy',
  fob: 'Entrega por conta do destinatário',
  outros: 'Outros',
} as const;

export const integracoesFreteSchema = z
  .enum([
    'mercadoLivre',
    'lojaIntegrada',
    'melhorEnvios',
    'amz',
    'magalu',
    'retiradaNaLoja',
    'shopee',
    'motoboy',
    'fob',
    'outros',
  ])
  .meta({ labels: INTEGRACAO_FRETE_LABELS });
export type IntegracaoFrete = z.infer<typeof integracoesFreteSchema>;

/* -------------------------------------------------------------------------- */
/*           Nested entity schemas — Transportadora, Veiculo, etc.            */
/*                                                                            */
/*  Flutter wire shapes — lowercase field names, NOT the NFe XSD names        */
/*  (`CNPJ`/`xNome`/`xEnder`…). The NFe orchestrator remaps to the XSD        */
/*  names at the `<transp>` boundary, exactly like Volume → `<vol>`           */
/*  (`apps/nfe/lib/nfe/orchestrator/generator-input.ts`).                     */
/* -------------------------------------------------------------------------- */

/**
 * Transportadora — Flutter wire shape from `Transportadora` at
 * `.old/packages/pedido/lib/src/models.dart:796-848` (`cnpj`, `ie`, `nome`,
 * `endereco`, `municipio`, `uf`). There is no CPF field on the wire — the
 * legacy model only carries a 14-digit `cnpj`.
 */
export const transportadoraSchema = z
  .object({
    cnpj: z.string().nullable().default(null).describe('CNPJ'),
    ie: z.string().nullable().default(null).describe('Inscrição Estadual'),
    nome: z.string().max(60).nullable().default(null).describe('Razão social ou nome'),
    endereco: z.string().max(60).nullable().default(null).describe('Endereço'),
    municipio: z.string().max(60).nullable().default(null).describe('Município'),
    uf: ufSchema.nullable().default(null).describe('UF'),
  })
  .passthrough();
export type Transportadora = z.infer<typeof transportadoraSchema>;

/**
 * Veiculo — Flutter wire shape from `Veiculo` at
 * `.old/packages/pedido/lib/src/models.dart:860-895` (`placa`, `uf`,
 * `rntc`). `placa` and `uf` are required — the legacy decoder crashes on
 * null, so Flutter-written docs always carry both.
 */
export const veiculoSchema = z
  .object({
    placa: z.string().min(1).max(60).describe('Placa'),
    uf: ufSchema.describe('UF'),
    rntc: z.string().max(60).nullable().default(null).describe('RNTC'),
  })
  .passthrough();
export type Veiculo = z.infer<typeof veiculoSchema>;

/**
 * Reboque (trailer) — separate legacy class
 * (`.old/packages/pedido/lib/src/models.dart:907-934`) with the same wire
 * shape as Veiculo.
 */
export const reboqueSchema = veiculoSchema;
export type Reboque = Veiculo;

/**
 * Dimensões (cm) of a Volume. Mirrors `Dimensoes` at
 * `.old/packages/pedido/lib/src/models.dart:1048` — all three required.
 */
export const dimensoesSchema = z
  .object({
    altura: z.number().describe('Altura (cm)'),
    largura: z.number().describe('Largura (cm)'),
    comprimento: z.number().describe('Comprimento (cm)'),
  })
  .passthrough();
export type Dimensoes = z.infer<typeof dimensoesSchema>;

/**
 * Volume — Flutter wire shape from `Volume` at
 * `.old/packages/pedido/lib/src/models.dart:955-1037` (`quantidade`,
 * `especie`, `pesoBruto`…), NOT the NFe XSD `<vol>` names (`qVol`, `esp`,
 * `pesoB`…). The NFe orchestrator remaps to XSD names at the `<transp>`
 * boundary (`apps/nfe/lib/nfe/orchestrator/generator-input.ts`).
 */
export const volumeSchema = z
  .object({
    quantidade: z
      .number()
      .int()
      .nullable()
      .default(null)
      .describe('Quantidade de volumes transportados'),
    especie: z.string().max(60).nullable().default(null).describe('Espécie'),
    marca: z.string().max(60).nullable().default(null).describe('Marca'),
    numero: z.string().max(60).nullable().default(null).describe('Numeração'),
    pesoBruto: z.number().nullable().default(null).describe('Peso Bruto (KG)'),
    pesoLiquido: z.number().nullable().default(null).describe('Peso Líquido (KG)'),
    dimensoes: dimensoesSchema.nullable().default(null).describe('Dimensões'),
    lacres: z.array(z.string()).nullable().default(null).describe('Lacres'),
  })
  .passthrough();
export type Volume = z.infer<typeof volumeSchema>;

/* -------------------------------------------------------------------------- */
/*                          FreteDoPedido — main schema                       */
/* -------------------------------------------------------------------------- */

/**
 * FreteDoPedido — shipping block embedded as `pedido.freteInicial`.
 * Ported from `.old/packages/pedido/lib/src/models.dart:389-625`.
 * `.passthrough()` for any Flutter-only fields not enumerated below.
 */
export const freteDoPedidoSchema = z
  .object({
    // External tracking ----------------------------------------------------
    externalId: z.string().nullable().default(null).describe('ID externo'),
    printLabelId: z.string().nullable().default(null).describe('ID da etiqueta'),
    externalOptionId: z.string().nullable().default(null).describe('Opção externa (ID)'),
    externalOptionIntegracao: integracoesFreteSchema
      .nullable()
      .default(null)
      .describe('Integração da opção externa'),
    externalOptionData: z
      .record(z.string(), z.unknown())
      .nullable()
      .default(null)
      .describe('Dados da opção externa'),
    /** Selection moment for the marketplace freight option (ms since epoch). */
    externalOptionSelectionDate: z
      .number()
      .int()
      .nullable()
      .default(null)
      .describe('Data de seleção da opção externa'),

    // Status + routing ------------------------------------------------------
    estado: estadoFreteSchema.describe('Estado do frete'),
    integracaoFreteOuterRef: z.unknown().nullable().default(null).describe('Integração do frete'),
    integracaoTargetOuterRef: z.unknown().nullable().default(null).describe('Target da integração'),
    /** Legacy path field; kept for parse compatibility, slated for removal. */
    integracao_path: z.string().nullable().default(null).describe('Path da integração'),

    // Recipients ------------------------------------------------------------
    clienteRecebedorOuterReference: z
      .unknown()
      .nullable()
      .default(null)
      .describe('Cliente recebedor'),
    enderecoFreteOuterReference: z
      .unknown()
      .nullable()
      .default(null)
      .describe('Endereço de entrega'),

    // Modality + entities ---------------------------------------------------
    modalidade: modalidadeFreteSchema.default('0').describe('Modalidade'),
    transportadora: transportadoraSchema.nullable().default(null).describe('Transportadora'),
    veiculo: veiculoSchema.nullable().default(null).describe('Veículo'),
    reboques: z.array(reboqueSchema).nullable().default(null).describe('Reboques'),
    vagao: z.string().max(20).nullable().default(null).describe('Vagão'),
    balsa: z.string().max(20).nullable().default(null).describe('Balsa'),
    volumes: z.array(volumeSchema).nullable().default(null).describe('Volumes'),
    /** Tracking code (max 200 per Flutter constraint). */
    codRastreio: z.string().max(200).nullable().default(null).describe('Código de rastreio'),

    // Costs -----------------------------------------------------------------
    valorCobrado: z.number().nullable().default(null).describe('Valor cobrado do frete'),
    custoCalculado: z.number().nullable().default(null).describe('Custo calculado'),
    custoFinal: z.number().nullable().default(null).describe('Custo final'),

    // Schedule — DateTime fields stored as ms since epoch -------------------
    ehReverso: z.boolean().default(false).describe('Frete reverso'),
    /** Extra days added to the shipping deadline. */
    prazoExtra: z.number().int().default(0).describe('Prazo extra (dias)'),
    /** Max dispatch deadline (the field the table view's "Expedição" column reads). */
    prazoDespacho: z.number().int().nullable().default(null).describe('Prazo de despacho'),
    dataEntrega: z.number().int().nullable().default(null).describe('Data de entrega'),
    dataPrevisaoEntrega: z.number().int().nullable().default(null).describe('Previsão de entrega'),

    // Insurance + delivery options -----------------------------------------
    valor_assegurado: z.number().nullable().default(null).describe('Valor assegurado'),
    maoPropria: z.boolean().nullable().default(null).describe('Mão própria'),
    avisoRecebimento: z.boolean().nullable().default(null).describe('Aviso de recebimento'),

    // Timestamps — ms since epoch ------------------------------------------
    ultimaModificacao: z.number().int().nullable().default(null).describe('Última modificação'),
    timestamp: z.number().int().nullable().default(null).describe('Criação'),
  })
  .passthrough();
export type FreteDoPedido = z.infer<typeof freteDoPedidoSchema>;
