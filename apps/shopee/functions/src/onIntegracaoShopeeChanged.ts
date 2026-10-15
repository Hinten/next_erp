import { logger } from 'firebase-functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { intFreteContaSync } from '@delfrance/data/admin/frete';
import { integracaoMeta, VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

import { shopIdResolvivel } from '../../lib/shopee/core/contaCache';
import { redriveDeferredSemContaForShopId } from '../../lib/shopee/notificacoes/notificacao';
import { getDb } from './lib/admin';

/**
 * The Shopee binding of the shared `int_frete` ⇆ conta core. Zero options — the
 * window pass (`tools/migrations/src/2026-10-shopee-int-frete/`) builds the very
 * same one, so the trigger and the backfill can never decide differently.
 */
const sync = intFreteContaSync(VINCULO_INT_FRETE_CONTA.shopee);

/**
 * Shopee conta trigger (master plan step 20, #1528) — the codebase's THIRD
 * Firestore trigger, and the SECOND `onDocumentWritten` on `integracao`
 * (Mercado Livre's `onIntegracaoMercadoLivreChanged` is the first). It carries
 * TWO independent responsibilities:
 *
 *  1. **`int_frete` sync.** A Shopee conta owns ONE freight doc (tipo
 *     `shopee`, back-ref `contaShopeeFreteOuterRef`). The legacy Flutter conta
 *     screen upserted it on every save; the new stack saves the conta through a
 *     plain `ObjectView` with no companion write, so this trigger keeps it in
 *     step. All the logic is the shared core `@delfrance/data/admin/frete`
 *     (#1369): this file passes it the conta ID and NOTHING else.
 *  2. **The #808 re-drive.** When a write makes the conta RESOLVABLE for a
 *     shop id (`shopIdResolvivel`, the payload twin of the push receiver's
 *     query), that shop's `sem-conta` deferred pushes go back to the hot lane,
 *     so they import within the next 30-minute sweep instead of the daily one.
 *
 * ---- Arm 1: state-driven, so a replay cannot roll anything back ----
 * `reconciliarIntFreteDaConta(db, id)` re-reads the conta INSIDE one
 * transaction and converges the freight doc to the conta as it stands at
 * commit: adopt the legacy doc by its back-ref, else create
 * `shopee-<integracaoId>`; patch only what moved; deactivate, never delete,
 * once the conta is gone or no longer Shopee. It takes no snapshot and no
 * event clock from here, which is the whole point: Eventarc is at-least-once
 * AND unordered, a redelivery replays the ORIGINAL before/after, and a replayed
 * delete of a conta that exists again simply re-syncs. Rule 7 class A — the
 * argument is the core's transaction-inventory row, not this file.
 * `deveReconciliar` is a COST pre-filter only; it is a positive gate, never an
 * early `return`, so arm 2 still runs for the writes it skips (the OAuth
 * `shop_id` stamp moves no mirrored field and is exactly what arm 2 is for).
 *
 * ---- Arm 2: the payload says "became resolvable", a FRESH read confirms ----
 * The edge is decided from the payload (`shopIdResolvivel(after)` set and
 * different from `before`'s), but a re-drive resets each row's `tentativas`, so
 * a stale or out-of-order event must not fire it: the conta is re-read, and
 * only when it STILL resolves to the same shop is the re-drive called. Through
 * the handle, never the cached `contaCache` reader — a cached copy is exactly
 * the stale view this guard exists to refuse.
 *
 * ⚠️ ORDER MATTERS, and it is the ordering — not a `catch` — that isolates the
 * two: the sync runs FIRST because it has no backstop (an import fires no
 * trigger, and only the one-shot window pass covers the past), and the
 * re-drive runs LAST because it is a latency cut the daily deferred lane
 * already covers. A throw in arm 2 can therefore never skip arm 1, on this
 * delivery or on any replay. Do not hoist it.
 *
 * ⚠️ Targets the NAMED `default` database, inlined at build time by
 * `build.mjs` (the step-11 trigger's docblock says why a runtime read cannot
 * cover it): an `onDocument*` bound to `(default)` deploys fine and NEVER fires.
 * No `region:` — `options.ts` sets it globally. `retry: true`: both arms are
 * replay-safe (arm 1 by construction, arm 2 because a replay finds no
 * `deferred` + `sem-conta` row left, and the fresh read refuses a stale edge).
 *
 * NO `secrets:` binding — this trigger never calls Shopee, and a needless
 * binding is one more Secret Manager grant that can 403 the function at
 * startup. `index.test.ts` asserts the empty set.
 *
 * COST: both gates are decided from the payload BEFORE `getDb()`. Every
 * channel's conta write (Mercado Livre, WhatsApp, balcão…) reaches this
 * function, and it returns before any read unless the conta is, or was, Shopee
 * — and not even then for a write that moves no mirrored field and no
 * resolvability (`tabelasAtacado`, the OAuth `main_account_id` merge). ⚠️ "Or
 * was" is not free: a conta retyped FROM Shopee to another channel passes
 * `deveReconciliar` (`antes !== depois`), so it pays the full reconcile (the
 * conta read, the lookup query, the deterministic-id read) and deactivates its
 * freight doc. Token refreshes never write the conta.
 *
 * No loop: it writes `int_frete` and `notificacoesShopee`, and neither has a
 * trigger in this codebase.
 */
export const onIntegracaoShopeeChanged = onDocumentWritten(
  {
    // The meta, never a literal: `integracao`.
    document: `${integracaoMeta.collectionPath}/{integracaoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    retry: true,
    // ⚠️ No `region:` (options.ts), no `secrets:`, no memory/timeout — see the
    // module docblock.
  },
  async (event) => {
    const { integracaoId } = event.params;
    const before = event.data?.before.exists
      ? (event.data.before.data() as Record<string, unknown>)
      : null;
    const after = event.data?.after.exists
      ? (event.data.after.data() as Record<string, unknown>)
      : null;

    // ---- arm 1: the int_frete sync (the PRIMARY responsibility) ----
    if (sync.deveReconciliar(before, after)) {
      const disposicao = await sync.reconciliarIntFreteDaConta(getDb(), integracaoId);
      logger.info('[shopee] onIntegracaoShopeeChanged', { integracaoId, ...disposicao });
    }

    // ---- arm 2: conta became RESOLVABLE → re-drive its sem-conta pushes (#808) ----
    // LAST on purpose — see the module docblock.
    const shopId = shopIdResolvivel(after);
    if (shopId == null || shopId === shopIdResolvivel(before)) return; // 0 reads

    const db = getDb();
    const atual = await integracaoCollection.docRef(db, {}, integracaoId).get();
    const contaAtual = atual.exists ? (atual.data() as Record<string, unknown>) : null;
    if (shopIdResolvivel(contaAtual) !== shopId) {
      logger.info('[shopee] redrive ignorado — a conta não resolve mais esta loja', {
        integracaoId,
        shopId,
      });
      return;
    }

    const { encontradas, semConta, redirecionadas, truncado } =
      await redriveDeferredSemContaForShopId(db, shopId);
    if (semConta > 0 || truncado) {
      logger.info('[shopee] conta resolvível — notificações sem-conta reprocessadas', {
        integracaoId,
        shopId,
        encontradas,
        semConta,
        redirecionadas,
        truncado,
      });
    }
  },
);
