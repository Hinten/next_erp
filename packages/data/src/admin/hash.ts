/**
 * `sha256Hex` — the deterministic-id digest the channel importers had a private
 * copy of, promoted in step 9 (#1517) on the third copy.
 *
 * ## Why an id is a digest at all
 *
 * A marketplace importer runs again and again over the same listing: a webhook
 * redelivery, the reprocess sweep, the mass-import job, an operator clicking
 * "importar" twice. Minting a fresh auto id on each pass forks the document —
 * two produtos for one listing, one of them invisible to the operator looking
 * at the other. Deriving the id from a preimage the provider also owns makes
 * the second write land on the first document by construction (root
 * `CLAUDE.md` rule 7, tier 0: make the race impossible rather than compare).
 *
 * ⚠️ **The preimage spelling is load-bearing, and this helper does not own it.**
 * Every caller spells its own — `${contaId}-${orderSn}`,
 * `shopee|${integracaoId}|${itemId}` — and a "harmless" reformat of that
 * template literal re-homes every document minted before it. So each caller
 * pins its digest character for character with its near-misses asserted
 * UNEQUAL, next to the function that builds the string. What lives HERE is only
 * the algorithm and the encoding.
 *
 * ## Why `@delfrance/data/admin` and not `@delfrance/core`
 *
 * `node:crypto` is server-only, and `packages/core/src` has ZERO `node:`
 * imports: its root barrel reaches every browser bundle through
 * `@delfrance/schemas` → `apps/web`, and `index.barrel.test.ts` is the guard
 * that keeps it that way. This subtree is the opposite by declaration —
 * Admin-SDK-only, never reached from a client bundle
 * (`adminBundleSafety.test.ts`) — and every caller of this helper already
 * depends on `@delfrance/data`, so the promotion costs no new dependency edge.
 *
 * ## ⚠️ `.update(input, 'utf8')` spells the encoding on purpose
 *
 * `createHash().update(string)` already defaults to utf8, so the digest is
 * BYTE-IDENTICAL to the private copies this replaces — which is exactly what
 * lets their pinned digests keep passing with their test files unedited. The
 * encoding is written out anyway because it is the one argument whose default
 * silently changes the answer for any non-ASCII preimage: read as latin1, a
 * produto name carrying `ção` hashes to a different id, and nothing anywhere
 * would say so. `hash.test.ts` pins that near-miss.
 *
 * Callers today: `apps/shopee/lib/shopee/pedidos/orderIds.ts` (steps 5/6) and
 * the step-9 produto ids. The two Mercado Livre copies
 * (`importacao/import.ts`, `importacao/importVariations.ts`) still declare
 * their own — a recorded follow-up, deliberately not folded into a Shopee PR,
 * since their `.update(s)` with no encoding argument yields the identical
 * digest and switching them would pull `ci-mercado-livre.yml`'s whole scope in
 * for zero behavioural change.
 */
import { createHash } from 'node:crypto';

/**
 * The hex-encoded SHA-256 of `input`, read as UTF-8: 64 lowercase hex
 * characters, stable across processes and machines.
 *
 * Pure — no clock, no randomness, no IO — so a deterministic doc id built on it
 * is reproducible from the preimage alone, which is what makes a re-import
 * idempotent and a migration rehearsal re-runnable.
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
