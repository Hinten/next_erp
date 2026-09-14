import { liquidacaoShopeeMeta, liquidacaoShopeeSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `liquidacaoShopee` per-conta cursor doc
 * (master-plan step 6, #1514) — the WEEKLY Shopee settlement sweep
 * (apps/shopee nested functions) reads the high-water mark and the pending
 * window before paging `get_escrow_list`, and merges it forward only after the
 * conta's window drained; doc id = integracaoId.
 *
 * ⚠️ Its clocks are MILLISECONDS (`cursorMs`, `lastSweepAtMs`, the two
 * `pendingWindow*Ms` bounds) — with the single exception the schema names in
 * its own suffix: `pendentes[].escrowReleaseTimeS` is the wire value in
 * SECONDS, converted once at the settlement write. See the schema's header.
 *
 * The sweep is this document's ONLY writer and writes it with a single `merge`
 * per conta per tick, so root rule 7 is satisfied at tier 0 by construction and
 * the sweep runs no Firestore transaction at all in the runner — nothing for the
 * transaction inventory to classify here. (Said WITHOUT the API's identifier on
 * purpose: the inventory guard greps every source file for that literal, and a
 * comment-only mention would demand an inventory line for a module that has no
 * transaction. The settlement WRITE is a different module, and it carries its
 * own inventory entry.) Admin-only / default-deny (see `liquidacaoShopeeMeta` —
 * the schema is not in `ALL_DOMAINS`), so there is no client access and no
 * generated rules block.
 */
export const liquidacaoShopeeCollection = defineAdminCollection({
  path: liquidacaoShopeeMeta.collectionPath,
  schema: liquidacaoShopeeSchema,
});
