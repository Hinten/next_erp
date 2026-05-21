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
/*  Starter shapes from the NFe XSD's `<transporta>`, `<veicTransp>`,         */
/*  `<reboque>`, `<vol>` blocks. `.passthrough()` so additional Flutter       */
/*  fields land cleanly until enumerated.                                     */
/* -------------------------------------------------------------------------- */

export const transportadoraSchema = z
  .object({
    CNPJ: z.string().nullable().default(null),
    CPF: z.string().nullable().default(null),
    xNome: z.string().nullable().default(null),
    IE: z.string().nullable().default(null),
    xEnder: z.string().nullable().default(null),
    xMun: z.string().nullable().default(null),
    UF: z.string().nullable().default(null),
  })
  .passthrough();
export type Transportadora = z.infer<typeof transportadoraSchema>;

export const veiculoSchema = z
  .object({
    placa: z.string().nullable().default(null),
    UF: z.string().nullable().default(null),
    RNTC: z.string().nullable().default(null),
  })
  .passthrough();
export type Veiculo = z.infer<typeof veiculoSchema>;

/** Reboque (trailer) shares Veiculo's shape per NFe XSD. */
export const reboqueSchema = veiculoSchema;
export type Reboque = Veiculo;

export const volumeSchema = z
  .object({
    qVol: z.number().nullable().default(null),
    esp: z.string().nullable().default(null),
    marca: z.string().nullable().default(null),
    nVol: z.string().nullable().default(null),
    pesoL: z.number().nullable().default(null),
    pesoB: z.number().nullable().default(null),
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
    externalId: z.string().nullable().default(null),
    printLabelId: z.string().nullable().default(null),
    externalOptionId: z.string().nullable().default(null),
    externalOptionIntegracao: integracoesFreteSchema.nullable().default(null),
    externalOptionData: z
      .record(z.string(), z.unknown())
      .nullable()
      .default(null),
    /** Selection moment for the marketplace freight option (ms since epoch). */
    externalOptionSelectionDate: z.number().int().nullable().default(null),

    // Status + routing ------------------------------------------------------
    estado: estadoFreteSchema,
    integracaoFreteOuterRef: z.unknown().nullable().default(null),
    integracaoTargetOuterRef: z.unknown().nullable().default(null),
    /** Legacy path field; kept for parse compatibility, slated for removal. */
    integracao_path: z.string().nullable().default(null),

    // Recipients ------------------------------------------------------------
    clienteRecebedorOuterReference: z.unknown().nullable().default(null),
    enderecoFreteOuterReference: z.unknown().nullable().default(null),

    // Modality + entities ---------------------------------------------------
    modalidade: modalidadeFreteSchema.default('0'),
    transportadora: transportadoraSchema.nullable().default(null),
    veiculo: veiculoSchema.nullable().default(null),
    reboques: z.array(reboqueSchema).nullable().default(null),
    vagao: z.string().max(20).nullable().default(null),
    balsa: z.string().max(20).nullable().default(null),
    volumes: z.array(volumeSchema).nullable().default(null),
    /** Tracking code (max 200 per Flutter constraint). */
    codRastreio: z.string().max(200).nullable().default(null),

    // Costs -----------------------------------------------------------------
    valorCobrado: z.number().nullable().default(null),
    custoCalculado: z.number().nullable().default(null),
    custoFinal: z.number().nullable().default(null),

    // Schedule — DateTime fields stored as ms since epoch -------------------
    ehReverso: z.boolean().default(false),
    /** Extra days added to the shipping deadline. */
    prazoExtra: z.number().int().default(0),
    /** Max dispatch deadline (the field the table view's "Expedição" column reads). */
    prazoDespacho: z.number().int().nullable().default(null),
    dataEntrega: z.number().int().nullable().default(null),
    dataPrevisaoEntrega: z.number().int().nullable().default(null),

    // Insurance + delivery options -----------------------------------------
    valor_assegurado: z.number().nullable().default(null),
    maoPropria: z.boolean().nullable().default(null),
    avisoRecebimento: z.boolean().nullable().default(null),

    // Timestamps — ms since epoch ------------------------------------------
    ultimaModificacao: z.number().int().nullable().default(null),
    timestamp: z.number().int().nullable().default(null),
  })
  .passthrough();
export type FreteDoPedido = z.infer<typeof freteDoPedidoSchema>;
