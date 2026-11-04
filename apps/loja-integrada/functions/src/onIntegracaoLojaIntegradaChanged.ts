import { logger } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { integracaoMeta } from '@delfrance/schemas';

import { syncIntFreteLi } from '../../lib/lojaIntegrada/frete/intFrete';
import { getDb } from './lib/admin';

/**
 * Loja Integrada conta trigger (master plan step 20, #1826) — the codebase's FIRST Firestore
 * trigger. A Loja Integrada conta owns ONE freight doc (`int_frete`, tipo `lojaIntegrada`, back-ref
 * `contaLojaIntegradaEnviosOuterRef`). The legacy conta screen upserted it on every save; the new
 * stack saves the conta through a plain `ObjectView` with no companion write, so this trigger keeps
 * it in step. All the logic is the shared core `@delfrance/data/admin/frete` (#1369), reached
 * through the app's ONE binding, `syncIntFreteLi` (`lib/lojaIntegrada/frete/intFrete.ts`): this
 * file passes it the conta id and nothing else, and never builds a second binding.
 *
 * ---- State-driven, so a replay cannot roll anything back ----
 * `reconciliarIntFreteDaConta(db, id)` re-reads the conta inside the core's own transaction and
 * converges the freight doc to the conta as it stands at commit: adopt the migrated doc by its
 * back-ref, else create `lojaIntegrada-<integracaoId>` (rule 7 tier 0); patch only the mirrored
 * fields that moved; deactivate, never delete, once the conta is gone or no longer Loja Integrada.
 * It takes no snapshot and no event clock from here, which is the whole point: Eventarc is
 * at-least-once AND unordered, a redelivery replays the ORIGINAL before/after, and a replayed
 * delete of a conta that exists again simply re-syncs. Rule 7 class A — the argument is the
 * core's transaction-inventory row, not this file, which is why this app never spells the
 * transaction call (`lib/lojaIntegrada/estrutura.test.ts`).
 *
 * `deveReconciliar(before, after)` is a COST pre-filter only — the reconcile is correct for any
 * call. It is decided from the payload BEFORE `getDb()`: every channel's conta write (Mercado
 * Livre, Shopee, WhatsApp, balcão…) reaches this function, and it returns with ZERO reads unless
 * the conta is, or was, Loja Integrada — and not even then for a conta save that moves no
 * mirrored field (`nome`, `ativo`, the filial ref, `dataCadastro`). The credential lives in a
 * subcollection, so a token save or renewal never fires it at all. ⚠️ "Or was" is not free: a
 * conta retyped FROM Loja Integrada passes the filter and pays the full reconcile, which
 * deactivates its freight doc.
 *
 * ONE arm, unlike Shopee's two: Shopee's second arm re-drives deferred pushes when a conta becomes
 * resolvable, and this channel already covers that case with the deferred lane (re-driven on its
 * one-day window by `reprocessLojaIntegradaNotifications`, which ticks every 30 minutes) and the
 * credential routes' re-drive on a token save (step 3).
 *
 * ---- The database binding, and what the build define does and does not do ----
 * ⚠️ `database` is the repo's NAMED `default` database, never the `(default)` sentinel: a trigger
 * bound to `(default)` deploys fine and never fires. `process.env.FIREBASE_DATABASE_ID ?? 'default'`
 * already resolves an UNSET variable to `default`, the same way `src/lib/admin.ts` reads the
 * variable for `getDb()`. `build.mjs` defines the id anyway, built with `||`: that also turns a
 * BLANK export into `default` — under `??` a blank reaches firebase-functions as `''`, which it
 * binds as `(default)` (its `database || '(default)'`), the never-fires case — and it lets the
 * deploy preflight's table print the value the build baked (`tools/deploy-env/preflight.mjs`,
 * this codebase's `inlined` row). The define replaces EVERY read of the variable in the bundle,
 * `admin.ts`'s included: unbundled (the tests) both read the environment, but deployed, the
 * trigger's binding and `getDb()` share the one build-time value, and a runtime override reaches
 * neither. `index.test.ts` pins the analysed endpoint's `eventFilters.database` to exactly
 * `'default'` and the define in the build source; that offline pin, not the emulator, is the
 * guard for the binding.
 *
 * No `region:` — `options.ts` sets it globally. `retry: true`: the reconcile is replay-safe by
 * construction, and a lost race (two first syncs contending on `lojaIntegrada-<id>`) is exactly
 * what the retry patches. NO `secrets:` — this trigger never calls Loja Integrada (D17), and a
 * needless binding is one more Secret Manager grant that can fail the deploy. No memory or
 * timeout of its own.
 *
 * LOGS: the conta id and the core's disposition — the action plus field NAMES (`campos`,
 * `faltando`), never a value and never the conta's `nome` (`DisposicaoIntFrete`).
 *
 * No loop: it writes only `int_frete`, which has no trigger in this codebase.
 */
export const onIntegracaoLojaIntegradaChanged = onDocumentWritten(
  {
    // The meta, never a literal: `integracao`.
    document: `${integracaoMeta.collectionPath}/{integracaoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    retry: true,
    // ⚠️ No `region:` (options.ts), no `secrets:`, no memory/timeout — see the docblock.
  },
  async (event) => {
    const { integracaoId } = event.params;
    const before = event.data?.before.exists
      ? (event.data.before.data() as Record<string, unknown>)
      : null;
    const after = event.data?.after.exists
      ? (event.data.after.data() as Record<string, unknown>)
      : null;

    if (!syncIntFreteLi.deveReconciliar(before, after)) return; // 0 reads

    const disposicao = await syncIntFreteLi.reconciliarIntFreteDaConta(getDb(), integracaoId);
    logger.info('[loja-integrada] onIntegracaoLojaIntegradaChanged', {
      integracaoId,
      ...disposicao,
    });
  },
);
