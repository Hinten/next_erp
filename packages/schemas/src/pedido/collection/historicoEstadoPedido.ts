import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { microsSinceEpoch } from '../../datetime';
import { estadoPedidoSchema } from './pedido';

// Shares the PEDIDO permission domain (audit trail of the parent order).
const PERM_PEDIDO_READ = 1n << 16n;
const PERM_PEDIDO_WRITE = 1n << 17n;
const PERM_PEDIDO_DELETE = 1n << 18n;

/**
 * HistoricoEstadosPedido — subcoleção
 * `pedidos/{pedidoId}/historicoEstadoPedido` (matching the legacy
 * `HISTORICO_COLLECTION` constant). Mirrors
 * `.old/packages/pedido/lib/src/models.dart:3838`. One audit row per
 * `estado` transition of the parent pedido: the new state, who changed it,
 * and when.
 */
export const historicoEstadoPedidoSchema = z
  .object({
    estado: estadoPedidoSchema.describe('Estado'),
    usuarioHistoricoEstadosPedidoOuterRef: z.unknown().nullable().default(null).describe('Usuário'),
    data: microsSinceEpoch('Data').nullable().default(null),
  })
  .passthrough();

export type HistoricoEstadoPedido = z.infer<typeof historicoEstadoPedidoSchema>;

export const historicoEstadoPedidoMeta: CollectionMetadata = {
  collectionPath: 'pedidos/{pedidoId}/historicoEstadoPedido',
  permissions: {
    read: PERM_PEDIDO_READ,
    write: PERM_PEDIDO_WRITE,
    delete: PERM_PEDIDO_DELETE,
  },
};

export const historicoEstadoPedido = {
  schema: historicoEstadoPedidoSchema,
  meta: historicoEstadoPedidoMeta,
};
