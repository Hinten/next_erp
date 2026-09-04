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
 * ## The consent write stays TIER 0 — a plain `set` (root CLAUDE.md rule 7)
 *
 * ⚠️ **There IS a second writer now.** Step 2 added `./tokenStore.ts`, whose
 * leased refresher rotates the very same `current` document. `save()`
 * nevertheless stays a full-document `set`, and that asymmetry is the design
 * rather than an omission: the human reconnect must WIN, and the refresher
 * YIELDS to it through its own commit guard — it compares the stored
 * `refresh_token` against the one it spent and, when a consent has replaced the
 * pair meanwhile, drops its own and hands back the stored token.
 *
 * Rule 7 asks what happens when this write LOSES a race. Of the five reasons
 * this docblock used to give, reason 1 is now **false**, reason 3 is
 * **qualified**, and 2, 4 and 5 stand unchanged:
 *
 *  1. ⛔ ~~There is no second writer.~~ **False since step 2.** What survives is
 *     narrower and still enough: the two writers do not both decide the same
 *     field from a read — the consent writes an authoritative pair it just
 *     received, and the refresher's write is conditional on the pair it read.
 *  2. **Two callbacks cannot both reach this line.** The single-use attempt is
 *     redeemed BEFORE the exchange, at a fixed `current` doc id under Firestore's
 *     OCC; the second redemption of a single-use value must fail, and does.
 *  3. **Two consents in SEQUENCE are a human reconnect, where last-write-wins is
 *     the correct answer** — for the CONSENT, and only for it. This is the
 *     `force: true` reasoning in `apps/melhor-envio/lib/freight/tokenStore.ts`:
 *     an update-if-newer guard would let a stale-but-longer-lived stored token
 *     silently defeat a deliberate reconnect. ⚠️ It does NOT extend to the
 *     refresher, which is guarded precisely because it is not a human decision.
 *  4. **The single-token invariant holds vacuously.** The legacy `actokshopee`
 *     tokens are never migrated into this collection (master plan §5 item 4), so
 *     there is no stray-doc lineage to collapse at a fixed id.
 *  5. **A guarded write here would need a class-C inventory entry** in
 *     `firestore-transaction-inventory.test.js` describing a guard that guards
 *     nothing — an inventory line asserting the absence of a decision.
 *
 * ## The invariant `credentialFromTokenPair` carries
 *
 * ⚠️ It MUST emit the four lease/diagnostic keys **explicitly as `null`**, so a
 * consent CLEARS a lease a crashed refresher still holds and wipes a stale
 * failure stamp. Writing them explicitly is what makes the contract independent
 * of `save()` staying a full-document `set`: were it ever to become a merge, the
 * omitted keys would survive and the account would stay frozen until the lease
 * TTL elapsed. `parseMergePatch` drops `undefined`-valued keys before writing,
 * so `null` is the only spelling that clears anything.
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

/* -------------------------------------------------------------------------- */
/*                              Tolerant readers                              */
/* -------------------------------------------------------------------------- */

/**
 * A credential document as it comes back from `parseRead`.
 *
 * ⚠️ `parseRead` is SOFT — it logs and returns the RAW document on a schema
 * mismatch (migration tolerance, rule 8) — so nothing below may assume a type,
 * not even for the three fields `credenciaisIntegracaoSchema` declares. The four
 * step-2 fields are unmodelled `.passthrough()` keys and were never typed at
 * all.
 */
export type CredencialArmazenada = Readonly<Record<string, unknown>>;

/** The refresh lease held on a credential document. Milliseconds, like every stamp here. */
export interface RefreshLease {
  readonly owner: string;
  readonly expiraEm: number;
}

/**
 * A stored expiry a clock can actually be compared against, or `null`.
 *
 * An uncomparable value is treated as EXPIRED rather than as "fresh enough": a
 * comparison against `undefined` answers `false` for reasons that have nothing
 * to do with freshness, and the worst outcome of the safe direction is one extra
 * refresh.
 */
export function expiryOf(cred: CredencialArmazenada): number | null {
  const raw = cred.expirationDate;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** Same tolerance for the token itself: an unusable value is no token at all. */
export function accessTokenOf(cred: CredencialArmazenada): string | null {
  const raw = cred.access_token;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * The stored refresh token, or `null` when there is nothing to spend.
 *
 * ⚠️ Returned VERBATIM — never trimmed, never case-folded. This value is the
 * identity the refresh commit guard compares on, so any normalisation here would
 * make two DIFFERENT stored pairs read as the same one and let a refresh
 * overwrite a pair it did not derive from.
 */
export function refreshTokenOf(cred: CredencialArmazenada): string | null {
  const raw = cred.refresh_token;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * The live-or-not lease on this document, or `null` when there is none.
 *
 * ⚠️ A corrupt lease reads as NO lease — a non-string owner, an empty one, a
 * missing or non-finite expiry. ADR 0011's wrong-way default is the failure that
 * matters here: a hand-edited or half-written document must never be able to
 * freeze an account's refresh forever. This function answers "is anyone holding
 * it", never "has it expired"; the clock comparison belongs to the caller, which
 * owns `nowMs`.
 */
export function leaseOf(cred: CredencialArmazenada): RefreshLease | null {
  const owner = cred.refreshLeaseOwner;
  const expiraEm = cred.refreshLeaseExpiraEm;
  if (typeof owner !== 'string' || owner.length === 0) return null;
  if (typeof expiraEm !== 'number' || !Number.isFinite(expiraEm)) return null;
  return { owner, expiraEm };
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
 *
 * ⚠️ The four step-2 keys are emitted as an explicit `null` — see the module
 * header's invariant. A consent is the operator's authoritative statement about
 * this conta, so it clears a lease a crashed refresher still holds and drops the
 * failure stamp the panel renders; leaving the keys out would keep both.
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
    refreshLeaseOwner: null,
    refreshLeaseExpiraEm: null,
    ultimoRefreshEm: null,
    ultimaFalhaRefresh: null,
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
