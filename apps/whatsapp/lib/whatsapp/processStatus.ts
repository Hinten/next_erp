/**
 * Delivery-status processor for the WhatsApp Cloud API webhook (#527). Port of
 * `_processarStatus` (`.old/.../whatsapp_cloud_api/lib/src/notificacoes/
 * messages.dart:329-472`): each `statuses[]` entry advances the matching
 * OUTBOUND mensagem's `estadoEnvio`, guarded by a forward-only transition matrix
 * and the `lastExternalUpdateDateTime` out-of-order guard, appending any error
 * entries.
 *
 * ── Locating the mensagem (PR-3 contract) ─────────────────────────────────────
 * Legacy located the message by a collection-group query on `mid == status.id`.
 * This port instead reads the DETERMINISTIC doc directly:
 *   conversaId = conversaDocId(contaId, senderId(displayPhone, status.recipient_id))
 *   msgId      = mensagemDocId(contaId, status.id)
 * This requires PR-3's outbound sender to store each sent message at
 * `chat/{conversaId}/mensagem/{mensagemDocId(contaId, sendWamid)}` with
 * `mid = sendWamid` (re-anchoring the doc id to the wamid the Graph API returns).
 * A status whose message isn't found is logged and skipped (legacy behaviour) —
 * a soft miss, never a throw.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { mensagemCollection } from '@delfrance/data/admin/collections';
import { ESTADO_ENVIO, type EstadoEnvioMensagem } from '@delfrance/schemas';
import type { valuePayloadSchema } from '@delfrance/integrations-whatsapp-cloud-api';

import { conversaDocId, mensagemDocId, senderId } from './ids';

type ValuePayload = ReturnType<typeof valuePayloadSchema.parse>;

/** WhatsApp timestamps are unix SECONDS. */
function waTimestampToMs(ts: string): number {
  const secs = Number.parseInt(ts, 10);
  return Number.isFinite(secs) ? secs * 1000 : Date.now();
}

/** Coerce an ISO string (or legacy ms number) to epoch ms. */
function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * The forward-only transition matrix (messages.dart:356-408): when an incoming
 * status is NOT newer than the last one applied (`lastExternalUpdateDateTime >=
 * status.timestamp`), this decides whether the (stale) status is still applied
 * (`true` = the legacy `break`) or skipped (`false` = the legacy `continue`). A
 * status strictly newer than the last update bypasses this and always applies.
 */
function shouldApplyStale(status: string, estado: EstadoEnvioMensagem): boolean {
  switch (status) {
    case 'sent':
      return false; // a stale 'sent' is always ignored
    case 'delivered':
      return estado === ESTADO_ENVIO.enviando || estado === ESTADO_ENVIO.erro;
    case 'read':
      return (
        estado === ESTADO_ENVIO.enviando ||
        estado === ESTADO_ENVIO.enviado ||
        estado === ESTADO_ENVIO.erro
      );
    case 'failed':
      return estado !== ESTADO_ENVIO.erro;
    default:
      return false; // unknown status while stale → skip
  }
}

/** Map a WA error object (status/value level) to the mensagem `errors[]` shape. */
function mapError(e: unknown): {
  code: number;
  title: string;
  details: string | null;
  error_data: Record<string, unknown> | null;
} {
  const o = (e ?? {}) as Record<string, unknown>;
  return {
    code: typeof o.code === 'number' ? o.code : 0,
    title: typeof o.title === 'string' ? o.title : '',
    details:
      typeof o.message === 'string' ? o.message : typeof o.details === 'string' ? o.details : null,
    error_data:
      o.error_data != null && typeof o.error_data === 'object'
        ? (o.error_data as Record<string, unknown>)
        : null,
  };
}

/**
 * Apply every `statuses[]` entry to its outbound mensagem. A transient Firestore
 * failure PROPAGATES (throws) so the queue retries; a not-found message is
 * skipped.
 */
export async function processStatuses(
  db: Firestore,
  contaId: string,
  value: ValuePayload,
): Promise<void> {
  const displayPhone = value.metadata.display_phone_number;
  const statuses = value.statuses ?? [];
  const valueErrors = value.errors ?? null;

  for (let i = 0; i < statuses.length; i++) {
    const status = statuses[i]!;
    const sender = senderId(displayPhone, status.recipient_id);
    const conversaId = conversaDocId(contaId, sender);
    const msgId = mensagemDocId(contaId, status.id);
    const ref = mensagemCollection.docRef(db, { conversaId }, msgId);

    const snap = await ref.get();
    if (!snap.exists) {
      console.warn('[whatsapp] status ignorado — mensagem não encontrada', { mid: status.id });
      continue;
    }
    const mensagem = mensagemCollection.parseRead(
      snap.data(),
      mensagemCollection.docPath({ conversaId }, msgId),
    );

    const statusTs = waTimestampToMs(status.timestamp);
    const lastMs = toEpochMs(mensagem.lastExternalUpdateDateTime);

    // Out-of-order guard: only when the incoming status is NOT newer than the
    // last applied one does the forward-only matrix gate it.
    if (
      lastMs != null &&
      lastMs >= statusTs &&
      !shouldApplyStale(status.status, mensagem.estadoEnvio)
    ) {
      continue;
    }

    const statusIso = new Date(statusTs).toISOString();
    const patch: Record<string, unknown> = { lastExternalUpdateDateTime: statusIso };
    switch (status.status) {
      case 'sent':
        patch.estadoEnvio = ESTADO_ENVIO.enviando;
        break;
      case 'delivered':
        patch.estadoEnvio = ESTADO_ENVIO.enviado;
        break;
      case 'read':
        patch.estadoEnvio = ESTADO_ENVIO.recebido;
        patch.visualizado = statusIso;
        break;
      case 'failed':
        patch.estadoEnvio = ESTADO_ENVIO.erro;
        break;
      default:
        patch.estadoEnvio = ESTADO_ENVIO.desconhecido;
    }

    const errors = [...(mensagem.errors ?? [])];
    if (status.errors) for (const e of status.errors) errors.push(mapError(e));
    // A same-index entry in the top-level `value.errors` forces `erro` too.
    if (valueErrors) {
      const ve = valueErrors[i];
      if (ve != null) {
        patch.estadoEnvio = ESTADO_ENVIO.erro;
        errors.push(mapError(ve));
      }
    }
    if (errors.length > 0) patch.errors = errors;

    await mensagemCollection.merge(db, { conversaId }, msgId, patch);
  }
}
