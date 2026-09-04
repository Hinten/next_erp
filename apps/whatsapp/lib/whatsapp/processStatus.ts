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
 * A status whose message isn't found is logged, COUNTED and skipped (legacy
 * behaviour) — a soft miss, never a throw. See {@link StatusesReport}.
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

/** Coerce an epoch ms int (or a stray legacy ISO string) to epoch ms. */
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
 *
 * ⚠️ The parameter is the webhook's own literal union, not `string`, so the
 * exhaustiveness check covers this switch — widened to `string` the `deleted`
 * arm below would be indistinguishable from a `default`. Safe at runtime too:
 * `statusUpdateSchema.status` is a `z.enum`, so a value outside the five never
 * reaches here parsed (and an unparsed one would fall out returning `undefined`,
 * which is falsy — the same "skip" the old `default` gave).
 */
function shouldApplyStale(
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'deleted',
  estado: EstadoEnvioMensagem,
): boolean {
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
    case 'deleted':
      return false; // a stale 'deleted' is always ignored
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
 * What a `statuses[]` batch ACTUALLY did. Every iteration of the loop below hits
 * exactly one of these three, so they sum to `statuses.length` — and a
 * present-but-EMPTY `statuses: []` (truthy, so this function still runs) yields
 * all zeros, which is itself the honest answer and one no enum value could give.
 *
 * ⚠️ A COUNT, not a `MessagesFieldOutcome` member, and that is the whole point:
 * one batch can carry several entries with DIFFERENT fates, which a single enum
 * value structurally cannot express. `detail` names what happened to the
 * mensagem; this names what happened to the statuses (#1137 follow-up).
 *
 * ⚠️ Named `*Report`, not `*Outcome`: in this repo `*Outcome` is always a narrow
 * string union (`MessagesFieldOutcome`, `DropOutcome`, `InboundMessageOutcome`).
 * The neighbouring key in the very same `logger.info` is a `CacheReport`.
 *
 * ⚠️ `naoEncontrados` and `staleIgnorados` are kept APART on purpose, though both
 * mean "no write happened". A stale skip is working as designed AND structurally
 * common — the queue dispatches up to 3 concurrently, so `sent`/`delivered`/`read`
 * for one message routinely land out of order and the forward-only matrix refuses
 * the loser. A healthy channel therefore has a permanently nonzero `staleIgnorados`.
 * A not-found is the opposite: the outbound mensagem is not where the deterministic
 * doc-id derivation says it should be — a re-anchor that failed, a `recipient_id`
 * that is not what `senderId` assumes, or a foreign sender. Merged into one
 * counter, that signal sits under a permanent noise floor forever — which is the
 * same ambiguity, one level down, that `detail` was added to remove.
 */
export interface StatusesReport {
  /** The mensagem was found and patched — the one `merge()` in the loop. */
  aplicados: number;
  /** Soft miss: no mensagem at the deterministic id. Also `console.warn`ed per status. */
  naoEncontrados: number;
  /**
   * Not newer than the last applied update, and the forward-only matrix refused
   * it. Spelled to match Mercado Pago's existing `stale-ignorado` token for the
   * same phenomenon — one concept, one vocabulary, across the log family.
   */
  staleIgnorados: number;
}

/**
 * Apply every `statuses[]` entry to its outbound mensagem. A transient Firestore
 * failure PROPAGATES (throws) so the queue retries; a not-found message is
 * skipped.
 *
 * Returns {@link StatusesReport} rather than `void`: discarding it made a batch
 * whose every status was a soft miss report exactly like one that advanced every
 * mensagem — the OVERSTATEMENT named as a residual in #1478.
 *
 * ⚠️ The SWEEP re-drives `process` and therefore recomputes this report, then
 * discards it: `ReprocessResult.outcomes` is a `Record<string, number>` keyed by
 * the channel's constant disposition label, with no room for a nested object. A
 * replayed change's statuses report is invisible by construction — recorded here
 * so the next reader does not re-derive the question.
 */
export async function processStatuses(
  db: Firestore,
  contaId: string,
  value: ValuePayload,
): Promise<StatusesReport> {
  const displayPhone = value.metadata.display_phone_number;
  const statuses = value.statuses ?? [];
  const valueErrors = value.errors ?? null;
  const out: StatusesReport = { aplicados: 0, naoEncontrados: 0, staleIgnorados: 0 };

  for (let i = 0; i < statuses.length; i++) {
    const status = statuses[i]!;
    const sender = senderId(displayPhone, status.recipient_id);
    const conversaId = conversaDocId(contaId, sender);
    const msgId = mensagemDocId(contaId, status.id);
    const ref = mensagemCollection.docRef(db, { conversaId }, msgId);

    const snap = await ref.get();
    if (!snap.exists) {
      // ⚠️ Keep BOTH: the counter carries the RATE, this line carries the `mid`.
      // Chasing down which message the id derivation missed needs the mid, so the
      // warn is not made redundant by the count beside it.
      console.warn('[whatsapp] status ignorado — mensagem não encontrada', { mid: status.id });
      out.naoEncontrados += 1;
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
      out.staleIgnorados += 1;
      continue;
    }

    // millisecondsSinceEpoch INT wire format (#484/#486); `statusTs` is already ms.
    const patch: Record<string, unknown> = { lastExternalUpdateDateTime: statusTs };
    switch (status.status) {
      case 'sent':
        patch.estadoEnvio = ESTADO_ENVIO.enviando;
        break;
      case 'delivered':
        patch.estadoEnvio = ESTADO_ENVIO.enviado;
        break;
      case 'read':
        patch.estadoEnvio = ESTADO_ENVIO.recebido;
        patch.visualizado = statusTs;
        break;
      case 'failed':
        patch.estadoEnvio = ESTADO_ENVIO.erro;
        break;
      case 'deleted':
        // ⚠️ Persisted-state change (was `desconhecido` via the `default`).
        // `excluido` had no writer anywhere in the repo, yet the thread already
        // renders it (`ConversaTile.tsx`, `MensagemStatusIcon.tsx`) — the
        // messaging layer was waiting for exactly this. Messages already stamped
        // `desconhecido` by a previous `deleted` keep that value until their next
        // status update; nothing backfills them.
        patch.estadoEnvio = ESTADO_ENVIO.excluido;
        break;
      default:
        // Unreachable through `statusUpdateSchema`'s enum; an unparsed value
        // still lands somewhere honest rather than leaving `estadoEnvio` unset.
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
    out.aplicados += 1;
  }

  return out;
}
