# Gap: seller id, authorization flow, revocation, one app vs two

Provenance: read-only research dated 2026-10-14 for the Amazon SP-API marketplace integration (master plan `../amazon-marketplace-integration.md`). Scope: how a private or public app learns the seller id, the website authorization workflow, the cheapest validating read, revocation and secret rotation, and one app vs two during a migration. Sources: the official SP-API documentation (developer-docs.amazon; developer-docs.amazon.com redirects there), the official OpenAPI models (github.com/amzn/selling-partner-api-models) and, where stated, docs.aws.amazon.com. No live SP-API or AWS endpoint was called. Every claim carries its citation; UNKNOWN marks what the documentation does not settle. Facts about the legacy application's code are kept in the operator's private notes and are not part of this file.

---

# SP-API seller-account connection: research report (Amazon.com.br, A2Q3Y263D00KWC, NA endpoint)

The base for every docs URL below is `https://developer-docs.amazon/sp-api/docs/<slug>`, fetched as `<slug>.md`. Model paths are relative to `raw.githubusercontent.com/amzn/selling-partner-api-models/main/`. Most pages carry `updatedAt` 2026-09-09. `role-mappings` and `roles-in-the-selling-partner-api` were updated 2026-10-13.

## 1. Seller id / merchant token for a private, self-authorized app

**The self-authorization page doesn't mention it.** `self-authorization` never mentions a seller id, merchant token or selling_partner_id. What it does say:
- "Choose **Authorize app** for each selling partner account… Each time you choose **Authorize app**, a new refresh token appears. Generating a new refresh token doesn't invalidate previous refresh tokens."
- "To self-authorize a Seller Central account, you must be the Primary User of that account."

**Sellers API v1** (`models/sellers-api-model/sellers.json`) has exactly two operations:

| operationId | Method and path | Params | Rate / burst |
|---|---|---|---|
| `getMarketplaceParticipations` | GET `/sellers/v1/marketplaceParticipations` | none | 0.016 / 15 |
| `getAccount` | GET `/sellers/v1/account` | none | 0.016 / 15 |

Rates come from `paths.<path>.get.description`.

Response fields, all of them:
- `GetMarketplaceParticipationsResponse` = `{payload: MarketplaceParticipation[], errors: Error[]}`
  - `MarketplaceParticipation` = `{marketplace, participation, storeName}`
  - `Marketplace` = `{id, name, countryCode, defaultCurrencyCode, defaultLanguageCode, domainName}`
  - `Participation` = `{isParticipating, hasSuspendedListings}`
- `GetAccountResponse` = `{payload: Account, errors}`
  - `Account` = `{marketplaceParticipationList, businessType (enum CHARITY…INDIVIDUAL), sellingPlan (PROFESSIONAL|INDIVIDUAL), business, primaryContact}`
  - `Business` = `{name, registeredBusinessAddress, companyRegistrationNumber, companyTaxIdentificationNumber, nonLatinName}`
  - `PrimaryContact` = `{name, address, nonLatinName}`
  - `Address` = `{addressLine1, addressLine2, countryCode, stateOrProvinceCode, city, postalCode}`
- `Error` = `{code, message, details}`
- **Neither operation returns a seller id.** No property in `definitions` is named sellerId, merchantId or anything similar.
- `getAccount` is **EU only**: `role-mappings` § "Sellers API v1" gives "Regions: EU", with roles Account Information Service Provider or Finance and Accounting. It can't be used for BR (NA region).

**Official merchant-token guidance** (`submit-a-feed`): "Your Seller ID is located in Seller Central under **Settings** > **Account Info** > **Your Merchant Token**."
- `terminology` § Account: "You specify the account by providing a `sellerId` when you call certain SP-API operations."
- Listings model `listingsItems_2021-08-01.json`, `paths./listings/2021-08-01/items/{sellerId}/{sku}.*.parameters[sellerId]`: "A selling partner identifier, such as a merchant account or vendor code."
- `delete-an-application-from-your-developer-account` uses a different name: "For [seller apps], the authorization is the Merchant Customer ID". How that relates to the Merchant Token is UNKNOWN.

**Does any call return the seller id given only a refresh token?** No operation is documented for that purpose. I scanned 45 seller-side models for seller-id-like response fields. These exist as side effects:
- **Product Fees v0 `getMyFeesEstimateForASIN`** (POST `/products/fees/v0/items/{Asin}/feesEstimate`, rate 1 / burst 2).
  - The request has no seller field: `definitions.FeesEstimateRequest.properties` = MarketplaceId, IsAmazonFulfilled, PriceToEstimateFees, Identifier, OptionalFulfillmentProgram.
  - The response has `FeesEstimateResult.FeesEstimateIdentifier.SellerId` ("The seller identifier.").
  - The static sandbox example returns `"SellerId": "AXXXXXXXXXXXXX"` (`paths…feesEstimate.post.responses.200.x-amzn-api-sandbox.static[0]`).
  - Almost any role can call it, including Product Listing, Pricing and Selling Partner Insights (`role-mappings`).
- **Pricing v0 `getPricing`** (ItemType=Sku) → `Product.Identifiers.SKUIdentifier.SellerId`. It is required in `definitions.SellerSKUIdentifier`, but the call needs an existing SKU. The sandbox value is blank.
- **Finances 2024-06-19 `listTransactions`** → `transactions[].sellingPartnerMetadata.sellingPartnerId` ("The unique seller identifier"). It needs a posted transaction and the Finance and Accounting role.
- **Push notifications** carry SellerId, e.g. LISTINGS_ITEM_STATUS_CHANGE (`notification-type-values`). These need a subscription and an event, so they are not a direct call.
- Whether these live values equal the Merchant Token: UNKNOWN.

**Conclusion:** the documented route for a private app is manual. The user pastes the Merchant Token from Seller Central along with the refresh token.

## 2. Website authorization workflow (OAuth)

**Which apps can use it: public only.**
- `onboarding-step-6-set-up-the-authorization-workflow` titles the section "Website authorization workflow (public applications only)" and says "Self-authorization workflow (private applications only)".
- `application-authorization-limits`: Private gets 10 self-authorizations and OAuth is "Not available". An unlisted public app gets 25 seller OAuth authorizations; a listed one is unlimited.
- **A private app cannot use it.**

**Draft apps.** `version=beta` is still required in current docs (`website-authorization-workflow`, updated 2026-09-09):
- Add `version=beta` to test a Draft app. Without it you authorize the published version.
- Amazon adds `version=beta` to the log-in URI for Draft apps, and you must send it back on the callback URI.
- Error MD1000 is "when you authorize an SP-API application in `Draft` state through the OAuth production workflow" (`resolve-common-http-and-authorization-error-codes`).
- Going live means listing the app in the Appstore (Draft → Published), then removing `version=beta`.

**Parameters** (all from `website-authorization-workflow`):
- **Authorization URI:** `{Seller Central URL}/apps/authorize/consent?application_id=…&state=…[&version=beta]`. For BR the URL is `https://sellercentral.amazon.com.br` (`seller-central-urls`).
- **Log-in URI receives:** `amazon_callback_uri`, `amazon_state`, `selling_partner_id` ("The identifier of the selling partner who is authorizing your application"), and optional `version`.
- **Callback (your site → Amazon) sends:** `redirect_uri` (optional; it "Must match a URI you specified when you registered… If omitted, Amazon uses the first registered redirect URI"), `amazon_state`, `state`, and optional `version`.
- **Redirect URI receives:** `state`, `selling_partner_id`, `spapi_oauth_code`.
- **Code exchange:** POST `https://api.amazon.com/auth/o2/token` with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret`. It returns `access_token`, `token_type`, `expires_in` (typically 3600) and `refresh_token`.
- **`spapi_oauth_code` lifetime:** "expires after five minutes". "If the entire authorization process takes longer than 10 minutes, the workflow may break."

**Redirect URI rules:**
- Amazon sends authorization responses only to registered URIs, and you may register several (`authorize-public-applications`).
- "OAuth Redirect URI doesn't accept localhost: URIs" (`onboarding-step-7-register-your-first-production-application`).
- MD5101: the URI doesn't match a registered one. MD5110: the URI contains a fragment. MD9100: the app has no login URI or redirect URI.
- Set the header `Referrer-Policy: no-referrer`.
- Whether HTTPS is mandatory: UNKNOWN. All examples use https, but no rule says so.

**`mws_auth_token`:** 0 matches in the current website, Appstore, public-auth, reauthorize, self-auth and connecting pages. The archived guide (`github.com/amzn/selling-partner-api-docs` @548d815, `SellingPartnerApiDeveloperGuide.md`, around line 590) says it was "only passed when the seller is authorizing a hybrid… application" and not when you self-authorize your own MWS app.

**PKCE:** 0 matches for code_challenge, code_verifier or pkce in those same six pages. The documented exchange parameters are exactly the five listed above.

**Contradictions in the docs:**
- (a) `authorize-public-applications` says the Amazon callback URI is "Required for: The Selling Partner Appstore authorization workflow only. Not used in the website authorization workflow". The website workflow's steps 5–8 use it.
- (b) Refresh-token lifetime:
  - `onboarding-step-6`: "Refresh tokens do not expire."
  - `authorize-public-applications`: re-authorize "every 365 days", with a reminder 30 days before expiry.
  - `resolve-common-http-and-authorization-error-codes`: refresh tokens "are valid for 365 days".
  - `seller-authorizations-faq`: Amazon deactivates authorizations that have not been renewed in more than 365 days **and** have had no API call in that time.
  - For private apps, `authorizing-selling-partner-api-applications` says "Reauthorization is required when you add new roles."
  - Net result for a self-authorized token's lifetime: UNKNOWN.

## 3. Cheapest read-only validation of a newly entered refresh token

1. **LWA exchange** (`grant_type=refresh_token`). This checks the token against the client ID and secret. A wrong secret gives `invalid_client` (`lwa-credentials-faq`). The error for a revoked or invalid refresh token is not documented: UNKNOWN.
2. **`getMarketplaceParticipations`**: GET, no parameters, rate 0.016/s, burst 15.
   - It is **not grantless and not role "None"**. In NA it needs **Product Listing or Selling Partner Insights**; the other roles listed for it are "FE only" (`role-mappings`).
   - Missing role → 403 (`roles-in-the-selling-partner-api`).
   - Check that `payload[].marketplace.id == "A2Q3Y263D00KWC"` and `participation.isParticipating == true`. Brazil is in NA on `sellingpartnerapi-na.amazon.com` (`store-identifiers`, `sp-api-endpoints`).
   - It does **not** validate the pasted seller id.
3. **To check the Merchant Token too:** GET `/listings/2021-08-01/items/{sellerId}?marketplaceIds=A2Q3Y263D00KWC&pageSize=1` (`searchListingsItems`, rate 5 / burst 5, roles Product Listing or Inventory and Order Tracking). What happens when the sellerId doesn't match: UNKNOWN. Another option is to compare against `getMyFeesEstimateForASIN` → `SellerId` (§1).

Rate limits are "per the selling partner and application pair" (`usage-plans-and-rate-limits`).

## 4. Revocation

**Self-authorizations:** Manage Authorizations → Revoke Authorization → Self-Authorizations → "Choose **Revoke** for any authorization that you want to remove" (`revoke-authorizations`). This can't be undone (`delete-an-application-from-your-developer-account`). Whether a row is one refresh token or the whole app-and-account pair: UNKNOWN.

**OAuth authorizations:** "Only selling partners can revoke OAuth authorizations. When a selling partner revokes OAuth authorization for an app, the app is disabled". The seller does this through Manage Your Apps → Disable authorization, so revocation works per app, not per token. The developer "cannot revoke OAuth… using this self-service workflow" (delete-app page).

**Per-token revocation:** no API and no LWA revoke endpoint is documented. UNKNOWN.

**Two tokens for the same seller in one app:** both are valid (the self-authorization quote in §1). What revoking does to the other one: UNKNOWN.

**Client-secret rotation:**
- Refresh tokens survive it. `lwa-credentials-faq`: "No. Refresh tokens are linked to the LWA client identifier… You do not need to regenerate refresh tokens."
- The old secret works for 7 days, or in some cases "expire[s] immediately after rotation".
- Rotation is mandatory every 180 days, with a notice 90 days before. After the deadline you get "The LWA secret token you provided has expired." (`rotating-your-apps-lwa-credentials`).
- Rotation can be done programmatically with `rotateApplicationClientSecret`, which is grantless (`role-mappings` § Application Management).

## 5. One app or two apps during the migration

**Multiple apps per developer:** implied, not stated as a rule. You create one with "Add new app client" (`registering-your-application`), and the LWA FAQ says "rotate credentials for all your applications at the same time". The maximum number of apps: UNKNOWN.

**Roles are approved per developer profile and selected per app:**
- "When you register your SP-API application, you can choose roles from among those that you were approved for in your developer profile" (`roles-in-the-selling-partner-api`).
- "You can only select roles that Amazon approved for your developer account" (onboarding step 7).
- Restricted roles go through a three-stage review (business, security, technical) of the **developer profile** (`onboarding-step-3-create-a-developer-profile`).
- Private developers get a "streamlined review"; public developers need a "complete security review" (onboarding step 1).
- No doc says a new app needs a new role review. Whether a restricted role triggers any app-level step: UNKNOWN.
- Adding a role means: update the profile → approval → apply the role to the app → re-list → new authorization (refresh token).

**What differs with two apps (all documented):**
- Each app has its own authorization limit (10 self-authorizations for a private app).
- Each app has its own rate-limit bucket. With one app and two tokens, both systems share one bucket.
- Each app has its own client secret, so rotations don't need coordinating across systems.
- Revoking the old app's authorization doesn't touch the new app.

## Open questions only a live call or the Seller Central UI settles

- Is a Self-Authorizations row one token or the whole app-and-account pair? Does revoking it kill the other refresh tokens for that seller?
- Does a self-authorized private-app token expire after 365 days?
- Do `getMyFeesEstimateForASIN` `SellerId`, Finances `sellingPartnerId` and `getPricing` `SKUIdentifier.SellerId` come back populated, and do they equal the Merchant Token? (Also check whether Fees and Pricing v0 work for BR.)
- Does "Merchant Customer ID" equal the Merchant Token?
- What does `searchListingsItems` return when the sellerId doesn't match the token's seller? What does LWA return for a revoked refresh token?
- Is HTTPS mandatory for redirect URIs? Can an unlisted public app become Published without `version=beta`?
- Does an Appstore-listed public app accept PKCE parameters? (None are documented.)
- Does a second app under the same profile that picks restricted roles trigger any extra review? How many apps can one developer have?
- Is the Account Info → Merchant Token path the same on `sellercentral.amazon.com.br`?
- Do notification subscriptions and destinations conflict between two apps for the same seller? I did not check this.
