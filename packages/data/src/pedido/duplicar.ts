import { ESTADO_FRETE, ESTADO_PEDIDO, pedidoSchema } from '@delfrance/schemas';
import type { PedidoDevolucaoDataPort } from './port';
import { PedidoConflictError } from './usecases';

/**
 * Duplicar pedido (#370) — port of Flutter `CopiarPedidoAction`
 * (`.old/lib/pedido/pages/pedidoTableView.dart`): clone an existing pedido into
 * a fresh, independent create-form draft. Cliente, operação, itens and frete
 * carry through unchanged; every field below is state/print/marketplace
 * metadata that belongs to the ORIGIN pedido, not the new one, and is stripped
 * back to its schema default before the re-parse.
 *
 * Two fields the #370 legacy-context audit flagged as a bug in the Flutter
 * implementation (never stripped there, so a duplicate could carry stale
 * NFe-key / devolução data) are stripped here too, deliberately NOT
 * reproducing that gap: `chNFeReferenciadas`, `itensDevolvidos`.
 *
 * `entradasRelacionadas` / `saidasRelacionadas` / `estoqueAplicado` / `numero`
 * aren't part of the audit's strip list either, but a duplicate is a brand
 * new, unrelated pedido — carrying the origin's relational links or its
 * server-owned stock-application snapshot over would forge state that never
 * happened. Stripped here for the same reason
 * {@link import('./devolucao').buildDevolucaoIntegralSeed} strips its sibling
 * fields on the devolução integral seed.
 *
 * `foiImpresso`/`dtImpressao` pair the same way: carrying `foiImpresso: true`
 * over without a real print date would mark a never-printed draft as printed.
 */
export const DUPLICAR_PEDIDO_STRIP_KEYS = [
  'estado',
  'foiImpresso',
  'dtImpressao',
  'lastMarketplaceUpdate',
  'dataIndisponivelEstoque',
  'dataRemocaoEstoque',
  'ultimaModificacao',
  'timestamp',
  'error',
  'chNFeReferenciadas',
  'itensDevolvidos',
  'entradasRelacionadas',
  'saidasRelacionadas',
  'estoqueAplicado',
] as const;

/**
 * Build the pre-seeded create-form values for a "Duplicar pedido" (#370): the
 * origin pedido cloned with the {@link DUPLICAR_PEDIDO_STRIP_KEYS} removed and
 * re-parsed so schema defaults refill them (`estado` has no schema default, so
 * it is reset to `'iniciado'` explicitly — the duplicate restarts the flow,
 * same as the devolução integral seed). Pagamentos and incidentes are
 * subcollections, never read here, so they are never cloned — legacy carried
 * them over by omission (a bug, not intended UX); the new app defaults to
 * leaving them out per the #370 audit comment.
 *
 * `vendedorPedidoOuterRef` becomes the CURRENT logged-in user, not the
 * original seller — mirrors legacy. `numero` stays null; the create flow
 * (`createPedidoWithNumero`) mints a fresh one on save, same as any other new
 * pedido — the legacy `'COPIA <numero>'` convention doesn't fit here.
 *
 * Inside `freteInicial` (when present), only `externalId`/`printLabelId` are
 * stripped and `estado` is reset to `iniciado` (it has no schema default
 * either) — every other frete field (transportadora, volumes, endereços,
 * modalidade, valores…) carries through unchanged, exactly as the #370 audit
 * specifies.
 *
 * Throws `PedidoConflictError(null)` when the origin no longer exists.
 */
export async function buildDuplicarPedidoSeed(
  port: PedidoDevolucaoDataPort,
  args: { originId: string; usuarioRef: string | null },
): Promise<{ values: Record<string, unknown>; originNumero: string | null }> {
  const origin = await port.getPedido(args.originId);
  if (origin === null) throw new PedidoConflictError(null);
  const originNumero = typeof origin.numero === 'string' ? origin.numero : null;

  const clone: Record<string, unknown> = { ...origin };
  for (const key of DUPLICAR_PEDIDO_STRIP_KEYS) delete clone[key];

  if (clone.freteInicial != null && typeof clone.freteInicial === 'object') {
    const frete: Record<string, unknown> = { ...(clone.freteInicial as Record<string, unknown>) };
    delete frete.externalId;
    delete frete.printLabelId;
    frete.estado = ESTADO_FRETE.iniciado;
    clone.freteInicial = frete;
  }

  const values = pedidoSchema.parse({
    ...clone,
    estado: ESTADO_PEDIDO.iniciado,
    numero: null,
    vendedorPedidoOuterRef: args.usuarioRef,
  }) as Record<string, unknown>;

  return { values, originNumero };
}
