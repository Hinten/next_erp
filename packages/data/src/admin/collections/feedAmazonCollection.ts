import { registroFeedAmazonSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `feedsAmazon` record of one Amazon
 * `JSON_LISTINGS_FEED` submission (step 12a, PR 12-b); doc id
 * `idRegistroFeedAmazon(contaId, feedId)` = `<contaId>_<feedId>`, because a
 * `feedId` is unique only per seller.
 *
 * Root rule 7: the record is `create`d once, on the id Amazon returned (tier 0:
 * `ALREADY_EXISTS` means already recorded); every later write is an
 * `update(…, { lastUpdateTime })` on the snapshot it was derived from (tier 1),
 * with the status moving forward only and the terminal status written LAST.
 *
 * ⚠️ Every stamp is MILLISECONDS; the two non-epoch instants are
 * `relogioDesfecho`, a Firestore `Timestamp`, and `expiraEm`, the real `Date`
 * the TTL policy `feedsAmazon` keys on (stamped at creation). Always read by
 * id, never queried, so it has no composite index.
 *
 * Admin-only / default-deny (the schema is not in `ALL_DOMAINS` and exports no
 * `…Meta`), so there is no client access and no generated rules block.
 */
export const feedAmazonCollection = defineAdminCollection({
  path: 'feedsAmazon',
  schema: registroFeedAmazonSchema,
});
