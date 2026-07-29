import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { estadoFreteSchema } from '../../shared/frete';

// Shares the PEDIDO permission domain (audit trail of the parent order's
// freight block) — same bits as historicoEstadoPedido.ts.
const PERM_PEDIDO_READ = 1n << 16n;
const PERM_PEDIDO_WRITE = 1n << 17n;
const PERM_PEDIDO_DELETE = 1n << 18n;

/**
 * HistoricoAlteracaoFreteInicial — subcoleção
 * `pedidos/{pedidoId}/historicoFtIni` (matching the legacy
 * `HISTORICO_FRETE_INICIAL_COLLECTION` constant). Mirrors
 * `.old/packages/pedido/lib/src/models.dart:3895`. One audit row per
 * `freteInicial.estado` transition of the parent pedido.
 *
 * Written server-side wherever `freteInicial.estado` transitions — today the
 * Melhor Envio order-status webhook
 * (`apps/melhor-envio/app/api/webhooks/melhor-envio/route.ts`), which appends
 * a row in the SAME batch as the `freteInicial` patch. A tracking-only update
 * (no estado change) does NOT append a row — the legacy `tasks.dart` worker
 * followed the same rule.
 *
 * `data` is **ms since epoch**, NOT the repo-wide µs `microsSinceEpoch`
 * convention: this collection is also written by the legacy Flutter app
 * (`Pedido.save`, still running per ADR 0010), so the wire shape must stay
 * byte-compatible with it (confirmed against `models.g.dart`'s
 * `maybeDateTimeToJson`).
 */
export const historicoFreteInicialSchema = z
  .object({
    estado: estadoFreteSchema.describe('Estado do frete'),
    obs: z.string().nullable().default(null).describe('Observação'),
    data: z.number().int().nullable().default(null).describe('Data'),
  })
  .passthrough();

export type HistoricoFreteInicial = z.infer<typeof historicoFreteInicialSchema>;

export const historicoFreteInicialMeta: CollectionMetadata = {
  collectionPath: 'pedidos/{pedidoId}/historicoFtIni',
  permissions: {
    read: PERM_PEDIDO_READ,
    write: PERM_PEDIDO_WRITE,
    delete: PERM_PEDIDO_DELETE,
  },
  // An audit trail the audited party can rewrite is not an audit trail: rules
  // deny every client create/update/delete (no `su` bypass), leaving the
  // freight webhook (Admin SDK) as the sole writer. Read stays open to
  // `d_pedido` read. Same posture as historicoEstadoPedido.
  serverOwned: true,
  // Newest-first read, one page — mirrors historicoEstoque's defaultQuery.
  // Declaring it up front avoids the gap #717 found on the sibling
  // historicoEstadoPedido (an undeclared orderBy silently full-scans on this
  // Enterprise edition).
  defaultQuery: {
    orderBy: [{ field: 'data', direction: 'desc' }],
    limit: 50,
  },
};

export const historicoFreteInicial = {
  schema: historicoFreteInicialSchema,
  meta: historicoFreteInicialMeta,
};
