import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { PERM, hasPerm } from '@delfrance/auth';
import { incidenteCollection } from '@delfrance/data/admin/collections';
import { acaoBloqueadaSchema, nowMicros, toOuterRef } from '@delfrance/schemas';

import { getDb } from '../lib/admin';

const liberarInputSchema = z.object({
  pedidoId: z.string().min(1),
  incidenteId: z.string().min(1),
  /** Empty array revokes the release — the same call is the undo. */
  acoes: z.array(acaoBloqueadaSchema),
  motivo: z.string().max(2000).nullable().default(null),
});

/**
 * Release (or revoke) the marketplace-dispute block on ONE incidente (#1322).
 *
 * ## Why this is a callable and not a client write
 *
 * ⚠️ The incidentes subcollection is writable by anyone holding `pedido.write`,
 * so leaving `overrideBloqueio` as an ordinary field would hand the power to
 * dispatch a disputed order — and to emit its NF-e — to everyone who can fix a
 * shipping address. That is exactly the escalation #1224/#1234 rejected when
 * they gave claim RESOLUTION its own permission domain rather than a fourth
 * action on `pedido`. `overrideBloqueio` is therefore in
 * `incidenteMeta.serverOwnedFields` (the generated rules deny every client
 * write of it, superuser included) and this callable is its only writer,
 * gated on **`PERM.incidenteResolucao.write`** — the same bit that gates
 * refunding a buyer.
 *
 * ## Why an override exists at all
 *
 * Some claims are resolved BY shipping: a PNR (produto não recebido) mediation
 * where the right answer is to dispatch. Only ML closing the claim writes a
 * `resolucao`, so without a release an ML-driven flag we cannot clear ourselves
 * would strand the pedido indefinitely.
 *
 * ## What it does NOT do
 *
 * It does not touch the pedido. `onIncidenteBloqueioSync` observes this write
 * and recomputes `pedido.bloqueiosLiberados` from the OPEN incidentes — which
 * is what makes a release self-clearing when the claim closes, and keeps ONE
 * writer for the denormalized fields.
 *
 * ⚠️ Fails closed today: `PERM.incidenteResolucao` bits (107/108) are not on any
 * cargo until #1234 is decided and #173's re-mint runs, so nobody can call this
 * yet and every disputed pedido stays blocked. That is intended — a new
 * money-adjacent verb must not arrive switched on.
 */
export const liberarBloqueioIncidente = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Usuário não autenticado.');
  }
  const token = request.auth.token as { permissions?: string; su?: boolean };
  if (token.su !== true && !hasPerm(token.permissions, PERM.incidenteResolucao.write)) {
    throw new HttpsError('permission-denied', 'Sem permissão para liberar bloqueios do pedido.');
  }
  const parsed = liberarInputSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Dados inválidos para liberar o bloqueio.');
  }
  const { pedidoId, incidenteId, acoes, motivo } = parsed.data;

  const db = getDb();
  const ref = incidenteCollection.docRef(db, { pedidoId }, incidenteId);
  const snap = await ref.get();
  // Refuse rather than create: an override on an incidente that does not exist
  // would be invisible to the trigger (it folds over stored incidentes) and
  // would read to the caller as a successful release that does nothing.
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Incidente não encontrado.');
  }

  // A plain `update` of the one field — NOT a converter merge, which would
  // full-parse the patch and let the merge mask overwrite stored siblings.
  // Empty `acoes` stores an override that releases nothing, which is how a
  // revoke reads; the audit trail keeps who revoked it and when.
  await ref.update({
    overrideBloqueio: {
      acoes,
      data: nowMicros(),
      usuarioOuterRef: toOuterRef(`usuarios/${request.auth.uid}`),
      motivo,
    },
  });

  logger.info('[pedidos] bloqueio de incidente liberado', {
    pedidoId,
    incidenteId,
    acoes,
    por: request.auth.uid,
  });
  return { acoes };
});
