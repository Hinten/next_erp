import { estoqueShopeeSyncMeta, estoqueShopeeSyncSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `estoqueShopeeSync` per-conta state doc
 * (master-plan step 12, #1520) — the three flag-gated Shopee stock sweeps (the
 * quarter-hourly incremental, the nightly diário and the monthly reconciliação,
 * in `apps/shopee` nested functions) read the incremental cursor, the frozen
 * continuation of a truncated tick and the pause gate before discovering changed
 * produto families; the `update_stock` task handler merges pause state back
 * after a rate limit, a daily-quota refusal, holiday mode or a blocked shop; and
 * the manual push route pre-checks the gate to answer 409 without constructing a
 * client. Doc id = integracaoId.
 *
 * ⚠️ Its clocks are MILLISECONDS, like `backfillPedidosShopee` and
 * `liquidacaoShopee` and deliberately NOT like `estoqueMercadoLivreSync`, whose
 * twin spellings are microseconds. Root rule 7's own words are that a cross-unit
 * comparison is a guard that never fires, and every clock this document is
 * compared against on the Shopee side — the sweep's `nowMs`, the task payload's
 * stamps, the link docs' stamps — is ms. The unit is in every field name.
 *
 * ⚠️ ONE gate field, `pausadoAte`, and it is an EXPIRY rather than a latch. A
 * second daily-quota field was rejected on purpose: two gates are two readers
 * that can disagree, and all three consumers would have to consult both and take
 * a maximum. `pausaMotivo` carries the distinction instead.
 *
 * Every write is a `merge` — create-on-first-use is the point for a per-account
 * state doc, so the exists-only sibling would be the wrong method here. The
 * patches are FLAT either way: `continuacao` is written WHOLE as one top-level
 * key, never as dotted field paths.
 *
 * Admin-only / default-deny (see `estoqueShopeeSyncMeta` — the schema is not in
 * `ALL_DOMAINS`), so there is no client access and no generated rules block.
 */
export const estoqueShopeeSyncCollection = defineAdminCollection({
  path: estoqueShopeeSyncMeta.collectionPath,
  schema: estoqueShopeeSyncSchema,
});
