import { logger } from 'firebase-functions';
import { FUNCTIONS_REGION } from './options';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { mensagemMeta } from '@delfrance/schemas';

import { dispatchOutbound } from '../../lib/whatsapp/outbound';
import { getDb } from './lib/admin';

/**
 * Outbound send trigger for the WhatsApp Cloud API (#529). Fires on every
 * `chat/{conversaId}/mensagem/{mensagemId}` create and delegates to the pure
 * {@link dispatchOutbound} disposition, which transmits the message (when it is a
 * pending WhatsApp outbound: `estadoEnvio === salva && tipo not in {e,!} && mid ==
 * null && conversa.origem === 'whatsapp'`) and re-anchors it to the wamid so the
 * #527 status pipeline can locate it.
 *
 * ⚠️ Targets the repo's NAMED `default` Firestore database (gotcha #8); an
 * `onDocument*` that omits `database` binds to `(default)` and NEVER fires.
 *
 * `retry: true` → Eventarc at-least-once: a transient Firestore failure thrown by
 * the disposition is redelivered. Idempotency comes from the `mid != null`
 * fast-path on the re-anchored doc + the fresh original-doc re-read before sending
 * (a prior success deleted it); the residual double-send tail (send OK but
 * re-anchor throws) is documented in `outbound.ts`. `reprocessStaleOutbound`
 * (`index.ts`, `onSchedule`) is the second backstop for a send stuck in `salva`.
 */
export const sendOutbound = onDocumentCreated(
  {
    document: `${mensagemMeta.collectionPath}/{mensagemId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    region: FUNCTIONS_REGION,
    retry: true,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const { conversaId, mensagemId } = event.params as {
      conversaId: string;
      mensagemId: string;
    };
    const result = await dispatchOutbound(getDb(), conversaId, mensagemId, snap.data());
    logger.info('[whatsapp] sendOutbound', { conversaId, mensagemId, outcome: result.kind });
  },
);
