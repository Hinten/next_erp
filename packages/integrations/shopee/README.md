# @delfrance/integrations-shopee

Platform-neutral Shopee Open Platform library: **fetch-only**, no Firestore, no
Admin SDK, no `process.env`. The stateful half — the token store, the OAuth state
attempts, the push receiver, the sweeps — lives in `apps/shopee`.

What ships here:

| Module      | Holds                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| `sign.ts`   | The three HMAC-SHA256 base strings (public / shop / merchant) and the signed query builder |
| `hosts.ts`  | The production and sandbox API + consent hosts, and the env-override resolver              |
| `oauth.ts`  | The consent URL (Format A), `exchangeCode`, `refreshAccessToken`, `expiresAtFrom`          |
| `api.ts`    | Two typed clients — partner-scoped (public-signed) and shop-scoped                         |
| `types.ts`  | The `{ error, message, warning, request_id }` envelope and one Zod schema per operation    |
| `errors.ts` | The typed error hierarchy and the classification of Shopee's `error` code strings          |

## What it deliberately is not

- **No Firestore / Admin SDK / `@delfrance/data`.** ADR 0015: a channel package is a
  library, not a plugin, and the ERP orchestration lives in its app.
- **No token store, no refresh scheduling, no lease.** `refreshAccessToken` is a pure
  wire call; persisting and serialising the rotation is step 2 of the master plan.
- **No proxy and no `undici`.** `fetch` is injected, so `apps/shopee` can compose a
  static-egress fetch when the IP whitelist lands (P2 of the master plan).
- **No retry or backoff.** `ShopeeRateLimitError` carries `kind` (`'burst'` vs
  `'daily'`) and `retryAfterSeconds`; durable retry is the Cloud Tasks pipeline.
- **No push/webhook verification.** That signature is a _different_ base string (with
  a `|` separator) and belongs with the receiver.
- **No merchant flows** beyond `merchantBaseString` existing.
- **No `build` script**, deliberately: `ci.yml`'s seven-job split relies on no
  `packages/*` workspace defining one.

## Reading the docs

Shopee's own reference is readable without a login; see the master plan
`.master_plans/shopee/shopee-marketplace-integration.md` and its `shopee-doc.mjs`
helper. Every doc contradiction this package had to take a side on is written down
as a ⚠️ comment next to the seam it affects.
