import { z } from 'zod';
import type { CollectionMetadata } from './types';

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
export const itemDoPedidoSchema = z.object({
  produtoUid: z.string().nullable().default(null),
  ordem: z.number().int().default(1),
  ensureUniqueId: z.string().nullable().default(null),
  mktplaceId: z.string().nullable().default(null),
  sku: z.string().nullable().default(null),
  gtin: z.string().nullable().default(null),
  nomeDeVenda: z.string().nullable().default(null),
  precoDeVenda: z.number().min(0.01),
  descontoUnitario: z.number().min(0).default(0),
  quantidade: z.number().min(0),
  custo: z.number().nullable().default(null),
  timestamp: z.string().datetime().nullable().default(null),
  imposto: z.unknown().nullable().default(null),
}).passthrough();

export type ItemDoPedido = z.infer<typeof itemDoPedidoSchema>;

/**
 * Pedido schema. Outer references and complex nested structures (frete,
 * integração com marketplaces, totais derivados) stay pass-through;
 * Flutter still authors them. The Next app cares about kanban view +
 * estado transitions + simple item edits in this slice.
 */
export const pedidoSchema = z.object({
  ehSaida: z.boolean().default(true),
  hasUserInteraction: z.boolean().nullable().default(null),

  estado: estadoPedidoSchema,
  numero: z.string().nullable().default(null),

  // Outer references — kept opaque (resolved by Flutter today; UI here
  // surfaces the IDs through fetched lookups when needed).
  vendedorPedidoOuterRef: z.unknown().nullable().default(null),
  integracaoPedidoOuterRef: z.unknown(),
  operacaoPedidoOuterRef: z.unknown().nullable().default(null),
  clientePedidoOuterRef: z.unknown().nullable().default(null),
  enderecoFiscalOuterRef: z.unknown().nullable().default(null),
  listaDePrecosOuterRef: z.unknown().nullable().default(null),

  entradasRelacionadas: z.array(z.string()).nullable().default(null),
  saidasRelacionadas: z.array(z.string()).nullable().default(null),
  chNFeReferenciadas: z.array(z.string()).nullable().default(null),

  // itens is keyed by produtoUid (or 'NONE' / '' when no produto bound).
  itens: z.record(z.string(), z.array(itemDoPedidoSchema)).default({}),
  itensIds: z.array(z.string()).default([]),
}).passthrough();

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
