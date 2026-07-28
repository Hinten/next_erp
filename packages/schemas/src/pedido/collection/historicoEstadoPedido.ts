import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { microsSinceEpoch } from '../../shared/datetime';
import { outerRefSchema } from '../../shared/outerRef';
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
 *
 * Written EXCLUSIVELY by the `onPedidoEstadoChanged` Cloud Function
 * (`apps/functions/src/pedidos/registrarEstadoPedido.ts`), which observes every
 * `pedidos/{pedidoId}` write from every writer — the web editor, the Mercado
 * Pago webhook, Mercado Livre order import, scripts — and appends one row per
 * transition. Nothing appends rows at the call site any more, and
 * `serverOwned` makes a client attempt fail (`delfrance/no-client-estado-history-write`
 * catches it at lint time).
 */
export const historicoEstadoPedidoSchema = z
  .object({
    estado: estadoPedidoSchema.describe('Estado'),
    /**
     * `documents/usuarios/<uid>` of whoever caused the transition, or `null`
     * when there is no end user behind it (Admin-SDK writes: webhooks,
     * marketplace import, scripts). The trigger derives it from the Firestore
     * event's auth context and deliberately stores `null` rather than guessing
     * — see `resolveUsuarioOuterRef`.
     */
    usuarioHistoricoEstadosPedidoOuterRef: outerRefSchema
      .nullable()
      .default(null)
      .describe('Usuário'),
    data: microsSinceEpoch('Data').nullable().default(null),
    /**
     * CloudEvent id of the pedido write that produced this row — also the
     * document id, which is what makes the at-least-once trigger idempotent.
     * Null on legacy rows written before the trigger existed.
     */
    eventId: z.string().nullable().default(null),
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
  // An audit trail the audited party can rewrite is not an audit trail: rules
  // deny every client create/update/delete (no `su` bypass), leaving the
  // `onPedidoEstadoChanged` trigger as the sole writer. Read stays open to
  // `d_pedido` read. Same posture as `historicoDeModificacoes`.
  serverOwned: true,
};

export const historicoEstadoPedido = {
  schema: historicoEstadoPedidoSchema,
  meta: historicoEstadoPedidoMeta,
};
