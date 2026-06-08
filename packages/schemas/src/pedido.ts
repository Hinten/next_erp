import { z } from 'zod';
import type { CollectionMetadata } from './types';
import { freteDoPedidoSchema } from './frete';

const PERM_PEDIDO_READ = 1n << 16n;
const PERM_PEDIDO_WRITE = 1n << 17n;
const PERM_PEDIDO_DELETE = 1n << 18n;

/**
 * ESTADOS_PEDIDO enum, mirroring `packages/pedido/lib/src/models.dart`.
 * Stored on disk as the enum's `name` (e.g. `'pago'`, `'emAnalise'`).
 */
export const ESTADO_PEDIDO_LABELS = {
  iniciado: 'Iniciado',
  carrinho: 'Carrinho',
  carrinhoAbandonado: 'Carrinho abandonado',
  escolhendoFormaDePagamento: 'Escolhendo forma de pagamento',
  aguardandoConfirmacaoDePagamento: 'Aguardando confirmação',
  pagamentoNaoRealizado: 'Pagamento não realizado',
  emAnalise: 'Em análise',
  emProcessamento: 'Em processamento',
  pago: 'Pago',
  estornadoParcialmente: 'Estornado parcialmente',
  estornadoIntegralmente: 'Estornado integralmente',
  processandoCancelamento: 'Processando cancelamento',
  cancelado: 'Cancelado',
  fraude: 'Fraude',
  finalizado: 'Finalizado',
  error: 'Erro',
} as const;

export const estadoPedidoSchema = z
  .enum([
    'iniciado',
    'carrinho',
    'carrinhoAbandonado',
    'escolhendoFormaDePagamento',
    'aguardandoConfirmacaoDePagamento',
    'pagamentoNaoRealizado',
    'emAnalise',
    'emProcessamento',
    'pago',
    'estornadoParcialmente',
    'estornadoIntegralmente',
    'processandoCancelamento',
    'cancelado',
    'fraude',
    'finalizado',
    'error',
  ])
  .meta({ labels: ESTADO_PEDIDO_LABELS });
export type EstadoPedido = z.infer<typeof estadoPedidoSchema>;

/**
 * ItemDoPedido — embedded item structure inside `Pedido.itens`. Mirrors
 * `packages/pedido/lib/src/models.dart` ItemDoPedido. Nested complex
 * fields (`imposto`) are pass-through.
 */
export const itemDoPedidoSchema = z
  .object({
    produtoUid: z.string().nullable().default(null),
    ordem: z.number().int().default(1),
    ensureUniqueId: z.string().nullable().default(null),
    mktplaceId: z.string().nullable().default(null),
    sku: z.string().nullable().default(null),
    gtin: z.string().nullable().default(null),
    nomeDeVenda: z.string().nullable().default(null),
    precoDeVenda: z.number().min(0.01),
    descontoUnitario: z.number().min(0).nullable().default(0),
    quantidade: z.number().min(0),
    custo: z.number().nullable().default(null),
    timestamp: z.string().datetime().nullable().default(null),
    imposto: z.unknown().nullable().default(null),
  })
  .passthrough();

export type ItemDoPedido = z.infer<typeof itemDoPedidoSchema>;

/**
 * Pedido schema — aligned with the legacy Flutter `Pedido` class
 * (`.old/packages/pedido/lib/src/models.dart:2537–3498`). Every field
 * Flutter writes is enumerated below with the same nullability +
 * default semantics. `.passthrough()` is preserved on the outer
 * object so any not-yet-ported Flutter field still flows through.
 *
 * Timestamp convention: Dart `DateTime?` is serialized to Firestore
 * as `int` (milliseconds since epoch), confirmed by the legacy
 * table-view code (`DateTime.fromMillisecondsSinceEpoch(...)`).
 * UI components convert via `new Date(value)` at the display
 * boundary.
 */
export const pedidoSchema = z
  .object({
    // Direction flag --------------------------------------------------------
    ehSaida: z.boolean().default(true).describe('Saída'),
    hasUserInteraction: z.boolean().nullable().default(null).describe('Interação do usuário'),

    // Core state + numbering ------------------------------------------------
    estado: estadoPedidoSchema.describe('Pagamento'),
    numero: z.string().nullable().default(null).describe('Número'),

    // Outer references — opaque (resolved by Flutter today; UI dereferences
    // them through Firestore .get() when needed). `filialPedidoOuterRef` is
    // read by the NFe orchestrator (`apps/nfe/lib/nfe/orchestrator.ts:146`)
    // to load the issuing Filial — must be present on the doc when emitting.
    vendedorPedidoOuterRef: z.unknown().nullable().default(null).describe('Vendedor'),
    integracaoPedidoOuterRef: z.unknown().describe('Integração'),
    operacaoPedidoOuterRef: z.unknown().nullable().default(null).describe('Operação'),
    clientePedidoOuterRef: z.unknown().nullable().default(null).describe('Cliente'),
    enderecoFiscalOuterRef: z.unknown().nullable().default(null).describe('Endereço fiscal'),
    filialPedidoOuterRef: z.unknown().nullable().default(null).describe('Filial'),
    listaDePrecosOuterRef: z.unknown().nullable().default(null).describe('Lista de preços'),

    // Related orders --------------------------------------------------------
    entradasRelacionadas: z
      .array(z.string())
      .nullable()
      .default(null)
      .describe('Entradas relacionadas'),
    saidasRelacionadas: z
      .array(z.string())
      .nullable()
      .default(null)
      .describe('Saídas relacionadas'),
    chNFeReferenciadas: z
      .array(z.string())
      .nullable()
      .default(null)
      .describe('Chaves de NF-e referenciadas'),

    // Items (record keyed by produtoUid; 'NONE' / '' when no produto bound).
    itens: z.record(z.string(), z.array(itemDoPedidoSchema)).default({}).describe('Itens'),
    itensIds: z.array(z.string()).default([]).describe('IDs dos itens'),
    /** Returned items, nested by produto / volta. Heavy passthrough payload. */
    itensDevolvidos: z
      .record(z.string(), z.record(z.string(), z.array(itemDoPedidoSchema)))
      .nullable()
      .default(null)
      .describe('Itens devolvidos'),

    // Shipping --------------------------------------------------------------
    freteInicial: freteDoPedidoSchema.nullable().default(null).describe('Frete inicial'),

    // Totals (Flutter caches derived totals on the doc; the orchestrator
    // recomputes via itens but the table UI prefers the cached field).
    valorCobrado: z.number().nullable().default(null).describe('Valor cobrado'),
    descontoTotal: z.number().default(0).describe('Desconto total'),
    valorCusto: z.number().nullable().default(null).describe('Valor de custo'),
    valorFreteInicial: z.number().nullable().default(null).describe('Valor do frete inicial'),
    custoFreteInicial: z.number().nullable().default(null).describe('Custo do frete inicial'),
    valorDevolucao: z.number().nullable().default(null).describe('Valor de devolução'),
    valorCustoDevolvidos: z.number().nullable().default(null).describe('Valor de custo devolvido'),
    valorDespesasIncidentes: z.number().nullable().default(null).describe('Despesas incidentes'),
    valorFretesIncidentes: z.number().nullable().default(null).describe('Fretes incidentes'),
    valorComissoes: z.number().nullable().default(null).describe('Comissões'),
    impostos: z.number().nullable().default(null).describe('Impostos'),

    // Timestamps — all stored as ms since epoch ----------------------------
    /** Creation timestamp (ms since epoch). */
    timestamp: z.number().int().nullable().default(null).describe('Criação'),
    ultimaModificacao: z.number().int().nullable().default(null).describe('Última modificação'),
    /** Deprecated in Flutter (kept for parse compatibility). */
    dataFinalExpedicao: z
      .number()
      .int()
      .nullable()
      .default(null)
      .describe('Data final de expedição'),
    dataIndisponivelEstoque: z
      .number()
      .int()
      .nullable()
      .default(null)
      .describe('Indisponibilidade de estoque'),
    dataRemocaoEstoque: z.number().int().nullable().default(null).describe('Remoção de estoque'),
    lastMarketplaceUpdate: z
      .number()
      .int()
      .nullable()
      .default(null)
      .describe('Última atualização do marketplace'),

    // Print metadata --------------------------------------------------------
    foiImpresso: z.boolean().default(false).describe('Impresso'),
    /** Print date (ms since epoch). The table view renders an icon if set. */
    dtImpressao: z.number().int().nullable().default(null).describe('Data de impressão'),

    // NF-e + observability --------------------------------------------------
    /** When true the orchestrator refuses to emit NF-e for this pedido. */
    bloquearEmissaoNFe: z.boolean().nullable().default(null).describe('Bloquear emissão de NF-e'),
    observacoesInternas: z.string().nullable().default(null).describe('Observações internas'),
    /** infCpl: NF-e complementary text (DANFE-only field). */
    infCpl: z.string().nullable().default(null).describe('Informações complementares'),
    /** Persisted error message from the last failed write / emission. */
    error: z.string().nullable().default(null).describe('Erro'),
  })
  .passthrough();

export type Pedido = z.infer<typeof pedidoSchema>;

export const pedidoMeta: CollectionMetadata = {
  collectionPath: 'pedidos',
  permissions: {
    read: PERM_PEDIDO_READ,
    write: PERM_PEDIDO_WRITE,
    delete: PERM_PEDIDO_DELETE,
  },
  cascade: [
    { path: 'pedidos/{pedidoId}/itens', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/pagamentos', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/historicoEstadoPedido', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/incidentes', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/frete', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/nfev4', onDelete: 'cascade' },
  ],
};

export const pedido = { schema: pedidoSchema, meta: pedidoMeta };

/* -------------------------------------------------------------------------- */
/*                          Kanban / status helpers                           */
/* -------------------------------------------------------------------------- */

/**
 * Visual buckets for the kanban view. The 16 raw states are too many to
 * render as columns; we group into 4 lanes that match how the team
 * thinks about pedido lifecycle.
 */
export type EstadoBucket = 'aberto' | 'processo' | 'concluido' | 'cancelado';

export const ESTADO_BUCKET_LABELS: Record<EstadoBucket, string> = {
  aberto: 'Em aberto',
  processo: 'Em processo',
  concluido: 'Concluído',
  cancelado: 'Cancelado / Erro',
};

const BUCKET_BY_STATE: Record<EstadoPedido, EstadoBucket> = {
  iniciado: 'aberto',
  carrinho: 'aberto',
  escolhendoFormaDePagamento: 'aberto',
  aguardandoConfirmacaoDePagamento: 'aberto',
  emAnalise: 'processo',
  emProcessamento: 'processo',
  pago: 'concluido',
  finalizado: 'concluido',
  carrinhoAbandonado: 'cancelado',
  pagamentoNaoRealizado: 'cancelado',
  estornadoParcialmente: 'cancelado',
  estornadoIntegralmente: 'cancelado',
  processandoCancelamento: 'cancelado',
  cancelado: 'cancelado',
  fraude: 'cancelado',
  error: 'cancelado',
};

export function bucketOf(estado: EstadoPedido): EstadoBucket {
  return BUCKET_BY_STATE[estado];
}

/**
 * Helper to compute the subtotal of an item using the same formula as
 * the Flutter ItemDoPedido.subtotal getter:
 * `(precoDeVenda - descontoUnitario) * quantidade`.
 */
export function itemSubtotal(item: ItemDoPedido): number {
  return (item.precoDeVenda - (item.descontoUnitario ?? 0)) * item.quantidade;
}

export function pedidoTotal(p: Pedido): number {
  let sum = 0;
  for (const list of Object.values(p.itens)) {
    for (const item of list) {
      sum += itemSubtotal(item);
    }
  }
  return sum;
}
