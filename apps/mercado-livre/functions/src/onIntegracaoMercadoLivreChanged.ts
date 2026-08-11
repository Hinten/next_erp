import { logger } from 'firebase-functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { integracaoMeta } from '@delfrance/schemas';

import {
  contaRealmenteExcluida,
  desativarIntFreteDaConta,
  ehContaMercadoLivre,
  mudouCampoSincronizado,
  sincronizarIntFreteDaConta,
} from '../../lib/marketplace/intFreteSync';
import { redriveDeferredForUserId, userIdResolvivel } from '../../lib/marketplace/notificacao';
import { getDb } from './lib/admin';

/**
 * Mercado Livre conta trigger — fires on every `integracao/{integracaoId}` write
 * and carries TWO independent responsibilities:
 *
 *  1. **`int_frete` sync (#782)** — keeps the account's Mercado Envios freight
 *     config doc in step with the conta: created on connect, re-synced on edit,
 *     deactivated on delete.
 *  2. **Deferred-notification re-drive (#808)** — when a write makes the conta
 *     RESOLVABLE for an ML seller id, pulls every notification that has been
 *     waiting on that seller back into the hot sweep lane, so a backlog imports
 *     within ~30 minutes of connecting instead of within 24 hours.
 *
 * Both delegate to pure, unit-tested cores in `lib/marketplace/`
 * (`intFreteSync.ts`, `notificacao.ts`); this file is the thin wrapper (same
 * split as `onNfeAprovada` / `nfeUpload.ts`).
 *
 * The legacy Flutter conta screen did this inline on every save
 * (`cadastroConta.dart:91-101`); the new stack saves the conta through a plain
 * `ObjectView` with no companion write, so nothing created the doc and the Frete tab
 * rendered the editable generic block while the etiqueta row action vanished.
 *
 * ONE trigger, not two: `onDocumentWritten` already fires on a delete, so a separate
 * `onDocumentDeleted` would only ever double-handle it. The delete arm lives below.
 *
 * ⚠️ Targets the repo's NAMED `default` Firestore database (root gotcha); an
 * `onDocument*` that omits `database` binds to `(default)` and NEVER fires. The id is
 * inlined at build time by build.mjs — Firebase reads no env during codebase analysis.
 *
 * `retry: true` → Eventarc at-least-once, for TRANSIENT Firestore failures. A
 * redelivery replays the ORIGINAL CloudEvent (the same stale before/after snapshots,
 * not the current doc), which is safe on all three arms: the create/update arm diffs
 * the desired fields against what is stored and writes nothing when they already
 * match, the delete arm re-checks that the conta is really gone before touching
 * anything, and the re-drive arm writes fixed values to documents a replay no longer
 * finds (they left the deferred lane the first time round).
 *
 * NO `secrets:` binding — deliberately. This trigger never touches the ML API; per
 * `src/options.ts`'s per-function-secrets rule, a function with no ML API call must
 * not get the app credentials bound. The #808 arm keeps that true by only MARKING
 * notifications: the actual re-processing happens in the sweep, which does bind them.
 *
 * COST: every gate that can be decided from the event payload runs BEFORE `getDb()`,
 * so a write to a WhatsApp / Shopee / Magalu conta — or a Mercado Livre token
 * refresh — costs zero reads and zero writes. A `user_id` stamp is the one exception
 * and it is the point: that write is precisely what makes a seller resolvable, so it
 * pays for one indexed notification query (#808).
 *
 * No loop risk: it reads `integracao` and writes `int_frete` (no trigger) and
 * `notificacoesMercadoLivre` (no trigger).
 */
export const onIntegracaoMercadoLivreChanged = onDocumentWritten(
  {
    document: `${integracaoMeta.collectionPath}/{integracaoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    region: process.env.FUNCTIONS_REGION ?? 'us-east5',
    retry: true,
  },
  async (event) => {
    const { integracaoId } = event.params;
    const before = event.data?.before.exists
      ? (event.data.before.data() as Record<string, unknown>)
      : null;
    const after = event.data?.after.exists
      ? (event.data.after.data() as Record<string, unknown>)
      : null;
    // `data` comes from the event, never `Date.now()` — a redelivery must reproduce
    // the original stamp (`registrarEstadoPedido.ts`'s rule).
    const parsed = Date.parse(event.time);
    const eventTimeMs = Number.isNaN(parsed) ? Date.now() : parsed;

    // ---- delete arm --------------------------------------------------------
    if (after == null) {
      if (!ehContaMercadoLivre(before)) return; // any other channel: 0 reads, 0 writes
      // The guard: a replayed/out-of-order delete event must not deactivate a freight
      // doc whose conta has since come back. See `contaRealmenteExcluida`.
      if (!(await contaRealmenteExcluida(getDb(), integracaoId))) {
        logger.info(
          '[mercado-livre] onIntegracaoMercadoLivreChanged delete ignorado — a conta existe novamente',
          { integracaoId },
        );
        return;
      }
      const disposicao = await desativarIntFreteDaConta(getDb(), integracaoId, eventTimeMs);
      logger.info('[mercado-livre] onIntegracaoMercadoLivreChanged delete', {
        integracaoId,
        ...disposicao,
      });
      return;
    }

    // ---- tipo edited AWAY from Mercado Livre -------------------------------
    // Pathological but cheap to handle: leaving the freight doc live would keep an
    // orphaned marketplace integration selectable, the same trap the `ativo` case has.
    if (!ehContaMercadoLivre(after)) {
      if (!ehContaMercadoLivre(before)) return; // never was ours: 0 reads, 0 writes
      const disposicao = await desativarIntFreteDaConta(getDb(), integracaoId, eventTimeMs);
      logger.info('[mercado-livre] onIntegracaoMercadoLivreChanged tipo alterado', {
        integracaoId,
        ...disposicao,
      });
      return;
    }

    // ---- conta became RESOLVABLE → re-drive its deferred notifications (#808) ----
    // Runs BEFORE the skip-if-unchanged gate below, deliberately: that gate exists
    // to make a `user_id` stamp free for int_frete, and a `user_id` stamp is
    // exactly the write this arm has to see. It is the OAuth exchange
    // (`exchangeAndPersist`) denormalizing the seller id onto the conta — and also
    // the still-running Flutter app, which writes the field directly.
    //
    // Until this fires, every notification for that seller is parked in the
    // DEFERRED lane; the daily sweep would drain them within 24h regardless, so
    // this is purely a latency cut, and a failure here must not cost the
    // int_frete sync below. Still payload-gated: an unresolvable conta costs zero
    // reads, which is what keeps the WhatsApp/Shopee/Magalu writes free.
    const userIdAntes = userIdResolvivel(before);
    const userIdDepois = userIdResolvivel(after);
    if (userIdDepois != null && userIdDepois !== userIdAntes) {
      const redrive = await redriveDeferredForUserId(getDb(), userIdDepois);
      if (redrive.encontradas > 0) {
        logger.info('[mercado-livre] conta conectada — notificações adiadas reprocessadas', {
          integracaoId,
          userId: userIdDepois,
          ...redrive,
        });
      }
    }

    // ---- create / update arm -----------------------------------------------
    // Skip-if-unchanged: token refreshes and `user_id` stamps move none of the
    // mirrored fields, so they cost nothing. A create (`before == null`) always syncs.
    if (before != null && !mudouCampoSincronizado(before, after)) return;

    const disposicao = await sincronizarIntFreteDaConta(getDb(), integracaoId, after, eventTimeMs);
    logger.info('[mercado-livre] onIntegracaoMercadoLivreChanged', {
      integracaoId,
      ...disposicao,
    });
  },
);
