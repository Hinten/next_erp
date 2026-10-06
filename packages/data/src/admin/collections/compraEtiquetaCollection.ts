import { z } from 'zod';
import { millisSinceEpoch } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * The in-flight claim on a label purchase (#1677) — ONE document per pedido, at
 * `pedidos/{pedidoId}/compraEtiqueta/current`.
 *
 * `POST /api/freight/melhor-envio/comprar` (`apps/melhor-envio`) holds it for the
 * length of one buy, so a SECOND concurrent request for the same pedido answers
 * "em andamento" instead of creating — and paying for — a second label. The
 * semantics (an expiring lease, never renewed; a corrupt or far-future claim reads
 * as no claim; a fence on the resume anchor before every paid step) live in
 * `apps/melhor-envio/lib/freight/compraEtiqueta.ts`; this file is only the handle.
 *
 * ⚠️ Operational and **Admin-only / default-deny**, like `cargoClaims`: there is
 * no `*Meta`, it is not in `ALL_DOMAINS`, and neither ruleset has a match block
 * for the leaf — so clients can neither read nor forge a claim, and nothing here
 * needs `gen:rules`. Keep the leaf name off the rulesets' collection-group read
 * list (`match /{path=**}/<leaf>/…`): a leaf named like one of those would be
 * client-READABLE through that block.
 *
 * ⚠️ Deliberately a subcollection, NOT a field on `freteInicial`: every other
 * writer replaces `freteInicial` whole (so a claim there would be erased mid-run
 * or resurrected by a stale editor save), it feeds the pedido history and
 * `onPedidoChanged`, and rules-gen does not recurse into it.
 *
 * All clocks are **milliseconds** from the server's `Date.now()`, with `Ms` in the
 * field name — pedido stamps are µs, and a cross-unit comparison is a guard that
 * never fires (root rule 7).
 */
export const COMPRA_ETIQUETA_DOC_ID = 'current';

export const compraEtiquetaSchema = z
  .object({
    /** The request that holds the claim — a fresh `randomUUID()` per POST. */
    dono: z.string().min(1),
    leaseExpiraEmMs: millisSinceEpoch(),
    criadoEmMs: millisSinceEpoch(),
    /** Diagnostics only: who started the buy, and against which `int_frete`. */
    uid: z.string().nullable().default(null),
    intFreteId: z.string().nullable().default(null),
  })
  .passthrough();

export type CompraEtiqueta = z.infer<typeof compraEtiquetaSchema>;

export const compraEtiquetaCollection = defineAdminCollection({
  path: 'pedidos/{pedidoId}/compraEtiqueta',
  schema: compraEtiquetaSchema,
});
