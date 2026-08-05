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
import { getDb } from './lib/admin';

/**
 * Mercado Livre conta → Mercado Envios `int_frete` sync trigger (#782). Fires on
 * every `integracao/{integracaoId}` write and keeps the account's freight config doc
 * in step with it — created on connect, re-synced on edit, deactivated on delete.
 * All the logic is the pure, unit-tested core in `lib/marketplace/intFreteSync.ts`;
 * this file is the thin wrapper (same split as `onNfeAprovada` / `nfeUpload.ts`).
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
 * not the current doc), which is safe on both arms: the create/update arm diffs the
 * desired fields against what is stored and writes nothing when they already match,
 * and the delete arm re-checks that the conta is really gone before touching anything.
 *
 * NO `secrets:` binding — deliberately. This trigger never touches the ML API; per
 * `src/options.ts`'s per-function-secrets rule, a function with no ML API call must
 * not get the app credentials bound.
 *
 * COST: every gate that can be decided from the event payload runs BEFORE `getDb()`,
 * so a write to a WhatsApp / Shopee / Magalu conta — or a Mercado Livre token refresh
 * or `user_id` stamp — costs zero reads and zero writes.
 *
 * No loop risk: it reads `integracao` and writes `int_frete`, which has no trigger.
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
