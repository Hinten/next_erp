/**
 * Firestore-backed credential store for the Shopee OAuth token pair, over the
 * admin-only `integracao/{integracaoId}/credenciais` subcollection.
 *
 * First consumer of `credenciaisIntegracaoCollection`. The token pair never
 * reaches the browser: the collection is deliberately outside `ALL_DOMAINS`, so
 * the generated ruleset emits no match block for it and Firestore default-denies
 * every client read and write — only the Admin SDK, which bypasses rules, gets
 * here.
 *
 * ## The write is TIER 0 — a plain `set`, no transaction (root CLAUDE.md rule 7)
 *
 * Rule 7 asks what happens when this write LOSES a race. Five reasons say the
 * question does not arise yet, and the sixth says a transaction would make the
 * code worse rather than safer:
 *
 *  1. **There is no second writer.** This subcollection is admin-only and
 *     default-denied, and today `apps/shopee` has exactly one writer — the OAuth
 *     callback. There is no refresh flow yet (step 2), no sweep, no trigger.
 *  2. **Two callbacks cannot both reach this line.** The single-use attempt is
 *     redeemed BEFORE the exchange, at a fixed `current` doc id under Firestore's
 *     OCC; the second redemption of a single-use value must fail, and does.
 *  3. **Two consents in SEQUENCE are a human reconnect, where last-write-wins is
 *     the correct answer.** This is the `force: true` reasoning in
 *     `apps/melhor-envio/lib/freight/tokenStore.ts`: an update-if-newer guard
 *     would let a stale-but-longer-lived stored token silently defeat a
 *     deliberate reconnect.
 *  4. **The single-token invariant holds vacuously.** The legacy `actokshopee`
 *     tokens are never migrated into this collection (master plan §5 item 4), so
 *     there is no stray-doc lineage to collapse at a fixed id.
 *  5. **A transaction would need a class-C inventory entry** in
 *     `firestore-transaction-inventory.test.js` describing a guard that guards
 *     nothing — an inventory line asserting the absence of a decision.
 *
 * ⚠️ The escape hatch is the {@link ShopeeCredentialStore} PORT, not a comment:
 * step 2 replaces `save()`'s body with the leased, class-B transactional version
 * (re-read inside the transaction, compare the stored expiry, advance it on the
 * write that wins) without touching a single caller. When that lands, this
 * docblock is what has to be rewritten — reasons 1 and 3 both stop holding the
 * moment a background refresh exists.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { credenciaisIntegracaoCollection } from '@delfrance/data/admin/collections';
import type { CredenciaisIntegracao } from '@delfrance/schemas';
import type { ShopeeAuthSubject, ShopeeTokenPair } from '@delfrance/integrations-shopee';
import { z } from 'zod';

import { validationPaths } from './validationIssues';

/** Fixed doc id — one `integracao` is one Shopee shop for a BR local seller. */
export const SHOPEE_CREDENCIAL_DOC_ID = 'current';

/**
 * Subtracted from the expiry Shopee promised, so a token that is about to lapse
 * is treated as lapsed. Mirrors the Mercado Pago / Mercado Livre stores' −5 s.
 */
export const EXPIRY_GUARD_MS = 5_000;

/**
 * The credential document did not match `credenciaisIntegracaoSchema`.
 *
 * ⚠️ Exists so the OAuth callback can REDIRECT rather than 500. A bare
 * `z.ZodError` is not a `ShopeeError`, so it would fall past the callback's
 * guard and reach Next as an unhandled throw — the operator would see a stack
 * trace instead of `?shopee=error&reason=resposta_invalida`.
 *
 * ⚠️ `campos` carries field PATHS only. The value that failed to parse here IS
 * the token pair (#1015).
 */
export class ShopeeCredencialInvalidaError extends Error {
  readonly campos: readonly string[];

  constructor(message: string, campos: readonly string[]) {
    super(message);
    this.name = 'ShopeeCredencialInvalidaError';
    this.campos = [...campos];
  }
}

/**
 * Build the credential document from a fresh token pair.
 *
 * ⚠️ The seconds→milliseconds conversion happens in the PACKAGE
 * (`expiresAtFrom` produces `pair.expiresAtMs`) and nowhere else. Rule 7's
 * cross-unit trap is real in this repo — `ultimaModificacao` is µs on some
 * documents and ms on the ML links — so this module only ever subtracts a ms
 * guard from a ms value.
 *
 * The extra fields ride `credenciaisIntegracaoSchema`'s `.passthrough()`:
 * `shop_id` / `main_account_id` record WHICH id class the pair is keyed on
 * (step 2 refreshes per id class), and the two lists are stored so a
 * main-account fan-out never needs a second consent. Nothing reads the lists
 * today, deliberately.
 */
export function credentialFromTokenPair(
  pair: ShopeeTokenPair,
  subject: ShopeeAuthSubject,
  nowMs: number,
): Record<string, unknown> {
  return {
    access_token: pair.accessToken,
    refresh_token: pair.refreshToken,
    expirationDate: pair.expiresAtMs - EXPIRY_GUARD_MS,
    provider: 'shopee',
    shop_id: subject.kind === 'shop' ? subject.shopId : null,
    main_account_id: subject.kind === 'main_account' ? subject.mainAccountId : null,
    shop_id_list: pair.shopIdList === null ? null : [...pair.shopIdList],
    merchant_id_list: pair.merchantIdList === null ? null : [...pair.merchantIdList],
    obtidoEm: nowMs,
  };
}

export interface ShopeeCredentialStore {
  /** The `current` credential, or `null` when the conta was never connected. */
  load(): Promise<CredenciaisIntegracao | null>;
  /** Persist the credential at the fixed `current` doc id. See the module header. */
  save(cred: Record<string, unknown>): Promise<void>;
}

export function createShopeeCredentialStore(
  db: Firestore,
  integracaoId: string,
): ShopeeCredentialStore {
  const ctx = { integracaoId };

  return {
    async load(): Promise<CredenciaisIntegracao | null> {
      // The FIXED `current` doc, never "newest by expirationDate": picking the
      // newest could resurrect a stray doc (an interrupted write, a manual
      // edit) whose rotated refresh token Shopee has already invalidated.
      const snap = await credenciaisIntegracaoCollection
        .docRef(db, ctx, SHOPEE_CREDENCIAL_DOC_ID)
        .get();
      if (!snap.exists) return null;
      return credenciaisIntegracaoCollection.parseRead(
        snap.data(),
        credenciaisIntegracaoCollection.docPath(ctx, SHOPEE_CREDENCIAL_DOC_ID),
      );
    },

    async save(cred: Record<string, unknown>): Promise<void> {
      try {
        await credenciaisIntegracaoCollection.set(db, ctx, SHOPEE_CREDENCIAL_DOC_ID, cred);
      } catch (err) {
        // `set` validates against the schema before writing, so a Shopee
        // response missing `refresh_token` surfaces HERE rather than as a
        // document that cannot be refreshed later.
        if (err instanceof z.ZodError) {
          const campos = validationPaths(err.issues);
          throw new ShopeeCredencialInvalidaError(
            `Credencial Shopee inválida para a integração ${integracaoId}. Campos: ${campos.join(', ')}.`,
            campos,
          );
        }
        throw err;
      }
    },
  };
}
