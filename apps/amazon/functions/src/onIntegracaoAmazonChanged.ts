import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { integracaoMeta } from '@delfrance/schemas';

import { LOGGER_STDOUT_AMAZON, registrarEventoAmazon } from '../../lib/amazon/core/log';
import { syncIntFreteAmazon } from '../../lib/amazon/frete/intFrete';
import { getDb } from './lib/admin';

/**
 * Amazon conta trigger (master plan step 20, #1930) — the codebase's FIRST Firestore trigger, and
 * the FOURTH `onDocumentWritten` on `integracao/{id}` (Mercado Livre, Shopee and Loja Integrada
 * each own one in their codebase). An Amazon conta owns ONE freight doc (`int_frete`, tipo `amz`,
 * back-ref `contaAmazonContaFreteAmazonOuterRef`). The legacy conta screen upserted it on every
 * save; the new stack saves the conta with no companion write, so this trigger keeps it in step.
 * All the logic is the shared core `@delfrance/data/admin/frete` (#1369), reached through the
 * app's ONE binding, `syncIntFreteAmazon` (`lib/amazon/frete/intFrete.ts`): this file passes it
 * the conta id and nothing else, and never builds a second binding.
 *
 * ---- State-driven, so a replay cannot roll anything back ----
 * `reconciliarIntFreteDaConta(db, id)` re-reads the conta inside the core's own transaction and
 * converges the freight doc to the conta as it stands at commit: adopt the migrated doc by its
 * back-ref, else create `amz-<integracaoId>` (rule 7 tier 0); patch only the mirrored fields that
 * moved; deactivate, never delete, once the conta is gone or no longer Amazon. It takes no
 * snapshot and no event clock from here, which is the whole point: Eventarc is at-least-once AND
 * unordered, a redelivery replays the ORIGINAL before/after, and a replayed delete of a conta that
 * exists again simply re-syncs. Rule 7 class A — the argument is the core's transaction-inventory
 * row (`packages/config-eslint/rules/firestore-transaction-inventory.test.js`), not this file,
 * which is why this app never spells the transaction call (`lib/amazon/estrutura.test.ts`).
 *
 * `deveReconciliar(before, after)` is a COST pre-filter only — the reconcile is correct for any
 * call. It is decided from the payload BEFORE `getDb()`: every channel's conta write (Mercado
 * Livre, Shopee, Loja Integrada, WhatsApp, balcão…) reaches this function, and it returns with
 * ZERO reads unless the conta is, or was, Amazon — and not even then for a conta save that moves
 * no mirrored field (`nome`, `ativo`, the filial ref, `dataCadastro`). So these Amazon writes cost
 * nothing: the OAuth callback's seller binding and a save that only restamps `ultimaModificacao`;
 * and a credential write (the park's `reconexaoPendente`, a token persist) lives in a
 * subcollection, so it never fires this trigger at all. ⚠️ "Or was" is not free: a conta retyped
 * FROM Amazon passes the filter and pays the full reconcile, which deactivates its freight doc.
 *
 * ONE arm, unlike Shopee's two: Shopee's second arm re-drives deferred pushes when a conta becomes
 * resolvable. This channel chose no connect re-drive (step-3 plan), and its deferred lane already
 * re-drives `adiado/sem-conta` rows (`reprocessAmazonNotifications`, twice an hour).
 *
 * ---- The database binding, and what the build define does and does not do ----
 * ⚠️ `database` is the repo's NAMED `default` database, never the `(default)` sentinel: a trigger
 * bound to `(default)` deploys fine and never fires. `FIREBASE_DATABASE_ID ?? 'default'` already
 * resolves an UNSET variable to `default`, the same way `src/lib/admin.ts` reads the variable for
 * `getDb()`. `build.mjs` defines the id anyway, built with `||`: that also turns a BLANK export
 * into `default` — under `??` a blank reaches firebase-functions as `''`, which it binds as
 * `(default)` (its `database || '(default)'`), the never-fires case — and it lets the deploy
 * preflight's table print the value the build baked (`tools/deploy-env/preflight.mjs`, this
 * codebase's `inlined` row). The define replaces EVERY read of the variable in the bundle,
 * `admin.ts`'s included: unbundled (the tests) both read the environment, but deployed, the
 * trigger's binding and `getDb()` share the one build-time value, and a runtime override reaches
 * neither. `index.test.ts` pins the analysed endpoint's `eventFilters.database` to exactly
 * `'default'` and the define in the build source; that offline pin, not the emulator, is the
 * guard for the binding.
 *
 * No `region:` — `options.ts` sets it globally (`index.ts` imports it first). `retry: true`: the
 * reconcile is replay-safe by construction, and a stray `ALREADY_EXISTS` on the create (which the
 * SDK does not retry) is exactly what the Eventarc retry absorbs: the redelivery re-derives from
 * current state. NO `secrets:` — this trigger never calls Amazon (D11), and a needless binding is
 * one more Secret Manager grant that can fail the deploy. No memory or timeout of its own.
 *
 * No `try`/`catch` (root rule 6): the only reachable errors are Firestore's (contention, a gRPC
 * status) and Zod's (a create the schema refuses). Neither carries Amazon text, and both must
 * reach the Eventarc retry.
 *
 * LOGS — ONE line per reconcile, through the app's ONE logger (`LOGGER_STDOUT_AMAZON`, evento
 * `int-frete`): the conta id in the envelope, the action, the doc id, and the disposition's field
 * NAMES joined with commas (the sink takes primitives only), never a value and never the conta's
 * `nome`. WARNING on `incompleto` (a conta that cannot get its freight doc, so step 5's importer
 * will seed a null `integracaoFreteOuterRef`), INFO otherwise. ⚠️ On `incompleto` the shared core
 * ALSO writes its own unstructured warning line from `packages/data` (the conta id and field names
 * only), outside this logger: the declared departure (`apps/amazon/CLAUDE.md`, "int_frete binding
 * (step 20)").
 *
 * No loop: it writes only `int_frete`, which has no trigger in this codebase.
 */
export const onIntegracaoAmazonChanged = onDocumentWritten(
  {
    // The meta, never a literal: `integracao`.
    document: `${integracaoMeta.collectionPath}/{integracaoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    retry: true,
    // ⚠️ No `region:` (options.ts), no `secrets:` (no Amazon call, D11), no memory/timeout.
  },
  async (event) => {
    const { integracaoId } = event.params;
    const before = event.data?.before.exists
      ? (event.data.before.data() as Record<string, unknown>)
      : null;
    const after = event.data?.after.exists
      ? (event.data.after.data() as Record<string, unknown>)
      : null;

    if (!syncIntFreteAmazon.deveReconciliar(before, after)) return; // 0 reads

    const disposicao = await syncIntFreteAmazon.reconciliarIntFreteDaConta(getDb(), integracaoId);
    registrarEventoAmazon(
      LOGGER_STDOUT_AMAZON,
      'int-frete',
      disposicao.action === 'incompleto' ? 'WARNING' : 'INFO',
      '[amazon] onIntegracaoAmazonChanged',
      {
        acao: disposicao.action,
        intFreteId: disposicao.intFreteId ?? null,
        campos: disposicao.campos?.join(',') ?? null,
        faltando: disposicao.faltando?.join(',') ?? null,
      },
      { conta: integracaoId },
    );
  },
);
