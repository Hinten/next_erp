# Shopee Open Platform v2 — Survey A: authorization, signing, tokens, push, sandbox, sensitive data, BR journey

Phase 0 documentation survey. **Every claim below is sourced from a page actually read**; citations are
`guide N` (developer guide), `api <name>` (API reference), `push N` (push_api_id).
Where the docs are silent the entry says **UNKNOWN — docs do not say**. Nothing here is inferred from
Mercado Livre or from any other marketplace.

Pages read: guides 14, 16, 18, 20, 27, 31, 382, 644, 718, 735, 736, 739, 740, 741, 742, 743, 744, 745,
746, 747, 749. APIs: `v2.public.{get_access_token, refresh_access_token, get_shops_by_partner,
get_merchants_by_partner, get_token_by_resend_code, get_shopee_ip_ranges}`,
`v2.push.{set_app_push_config, get_app_push_config, get_lost_push_message,
confirm_consumed_lost_push_message}`, `v2.shop.{get_shop_info, get_profile}`,
`v2.merchant.{get_merchant_info, get_shop_list_by_merchant}`. Pushes: 15, 16, 12, 3 (+ metadata swept
across 20 push types).

---

## 1. Authorization flow

### 1.1 It is NOT OAuth2 in the RFC sense

It borrows OAuth2 vocabulary — `redirect_uri`, `response_type=code`, `state`, an authorization code
exchanged for tokens — but departs from RFC 6749 in ways that matter (`guide 20`):

- There is **no `client_id`/`client_secret`**; the app is identified by `partner_id` and authenticated
  by an **HMAC-SHA256 signature** (`sign`) over a concatenated base string, not by a bearer secret in
  the token request.
- There is **no `scope` parameter**. Permissions are fixed by the **App Category** chosen at creation
  and are immutable afterwards (`guide 740`).
- The token endpoint response has **no `token_type`**, no `scope`, and (see §2.3) an `expire_in` whose
  unit is ambiguous in the docs.
- `auth_type` (`seller` / `supplier` / `user`) has no OAuth2 analogue.

**PKCE: UNKNOWN — docs do not say.** No `code_challenge`, `code_challenge_method` or `code_verifier`
parameter appears anywhere in `guide 20`, `guide 644`, `guide 739` or `api v2.public.get_access_token`.
The parameter table in `guide 20` is presented as complete, and PKCE is absent from it. Treat PKCE as
**not supported**, but note the docs never explicitly deny it.

### 1.2 Authorize URL construction — TWO formats coexist

**⚠️ This is the single most confusing part of `guide 20`: the page documents a NEW unsigned link
format in prose, while every code sample on the same page builds a DIFFERENT, signed, legacy link.**

**Format A — the current documented format (`guide 20`, "Generating the authorization link"):**

```
<fixed auth URL>?partner_id=<int>&auth_type=seller&redirect_uri=<url>&response_type=code[&state=<nonce>]
```

Fixed authorization URLs (`guide 20`):

| Environment | Region | URL |
| --- | --- | --- |
| Production | Global (excl. Mainland China & Brazil) | `https://open.shopee.com/auth` |
| Production | Mainland China | `https://open.shopee.cn/auth` |
| Production | **Brazil** | **`https://open.shopee.com.br/auth`** |
| Sandbox | Global | `https://open.sandbox.test-stable.shopee.com/auth` |
| Sandbox | Mainland China | `https://open.sandbox.test-stable.shopee.cn/auth` |
| Sandbox | **Brazil** | **`https://open.sandbox.test-stable.shopee.com.br/auth`** |

Parameters (`guide 20`):

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `partner_id` | int | Yes | from the App |
| `auth_type` | string | Yes | `seller` (shop or merchant) / `supplier` (SCS) / `user` (livestream) |
| `redirect_uri` | string | Yes | must match the Redirect URL Domain declared in Console |
| `response_type` | string | Yes | fixed value `"code"` |
| `state` | string | No | "A random, unguessable string used to prevent CSRF attacks. It will be returned as-is to the redirect_uri" |

Worked example from `guide 20`:
`https://open.shopee.com/auth?partner_id=10090&auth_type=seller&redirect_uri=https://open.shopee.com&response_type=code`

**Format A carries NO `sign` and NO `timestamp`.**

**Format B — the legacy signed link, shown in every code sample in `guide 20` and in `guide 644`:**

```
<host>/api/v2/shop/auth_partner?partner_id=<id>&timestamp=<ts>&sign=<hex>&redirect=<url>
```

with the sign computed as a **Public-API** signature over the auth path:

```
base_string = partner_id + "/api/v2/shop/auth_partner" + timestamp
sign        = lowercase_hex( HMAC_SHA256(partner_key, base_string) )
```

(verbatim from the Python demo in `guide 20`:
`tmp_base_string = "%s%s%s" % (partner_id, path, timest)` where
`path = "/api/v2/shop/auth_partner"`).

Note the legacy link uses `redirect=` (not `redirect_uri=`) and a **host** (`partner.shopeemobile.com`),
whereas Format A uses a **portal domain** (`open.shopee.com`). `guide 20` acknowledges the legacy form
by referring to "the `redirect` parameter in legacy links" in its domain-validation notes.

The note "**The timestamp used to calculate the sign is only valid for 5 minutes. After the timestamp
and the sign expire, the authorization link will no longer be valid**" (`guide 20`) applies to Format B
— Format A has no timestamp to expire. **Which format to use in production for Brazil today is
genuinely ambiguous; resolve empirically against the live console before building.**

### 1.3 Redirect URL domain validation

`guide 20` + `guide 741`: each App declares a **Test Redirect URL Domain** and a **Live Redirect URL
Domain** in Console. If `redirect_uri`'s domain does not match, the platform returns:

> "The domain of redirect_uri is not consistent with the Redirect URL Domain declared in console"

`guide 739` gives the exact JSON:
```json
{"code":1,"error":"error_param","msg":"The domain of redirect_uri is not consistent with the Redirect URL Domain declared in console.","debug_message":""}
```

Grandfathering: "For Apps that have already been created but have not yet declared a callback URL
domain… the platform will not enforce domain validation" (`guide 20`). Production and Sandbox domains
are validated independently; if either is left empty, that environment is unvalidated.

### 1.4 What the redirect carries back

Depends on **which account type authorized** (`guide 20`):

- **Shop account** → `https://…?code=xxxxxxxxxx&shop_id=xxxxxx`
- **Main account** → `https://…?code=xxxxxx&main_account_id=xxxxxx`

| Param | Type | Meaning (`guide 20`) |
| --- | --- | --- |
| `code` | string | "valid for only once and expires after 10 minutes" |
| `shop_id` | int | returned when authorization was done on a **shop account** |
| `main_account_id` | int | returned when authorization was done on a **main account** |

**`state` is echoed back** per its parameter description, though `guide 20`'s worked redirect examples
omit it.

**Code validity window: one-time use, 10 minutes** (`guide 20`, `api v2.public.get_access_token`:
"Valid for one-time use, expires in 10 minutes").

### 1.5 Shop vs main account vs sub-account

`guide 20`, "Account types":
- **Shop account** — can authorize a **single shop**.
- **Main account** — can authorize **multiple merchants / shops**; the seller ticks which shops (and,
  for cross-border, a separate "Auth Merchant" checkbox).
- **Sub-account** — **cannot log in to the authorization page at all.**

So authorization is tied to **shop_id and/or merchant_id**, with `main_account_id` acting as the
umbrella identity that grants them. The main account is *not* itself a token subject after the first
refresh (see §2.4).

Counter-intuitive UI detail (`guide 20`): to log into a **main** account the seller must click
"**Switch to Sub Account**" on the login page.

The seller must pass an **SMS OTP** to reach the authorization page (`guide 20`). In sandbox the OTP is
always `123456` (`guide 644`).

### 1.6 Duration and expiry

- **Maximum 365 days** (`guide 20`, `guide 739`). `guide 18` states it as "only valid for 1 year".
- The **seller chooses** the duration at authorize time: presets of 7 / 30 / 90 / 180 / 365 days, or
  "Customize Expiration Time" to any date within 365 days (`guide 20`). **So an authorization can be as
  short as 7 days — you cannot assume a year.**
- On expiry: "Once the authorization expires, you will need to **contact the seller to re-authorize**
  your App" (`guide 20`); "Após 365 a conexão irá expirar e as APIs não irão funcionar" (`guide 739`).
  There is no programmatic renewal.
- **7 days before expiry** Shopee sends `open_api_authorization_expiry` (`push 12`, code 12) — see §7.
- The expiry timestamp is also readable per shop via `expire_time` on
  `api v2.public.get_shops_by_partner` and `api v2.shop.get_shop_info`, and per merchant via
  `api v2.public.get_merchants_by_partner` / `api v2.merchant.get_merchant_info`. **Polling
  `expire_time` is a more reliable expiry signal than push 12, which has `guarantee=0`.**

**SIP fan-out** (`guide 20`): "If a CB SIP primary shop grants authorization to an application, all SIP
linked shops will automatically receive the same authorization" — with limited API permissions on the
linked shops. Affiliate shops surface as `sip_affi_shop_list` on `api v2.public.get_shops_by_partner`.

### 1.7 Cancelling authorization

Two routes (`guide 20`):
1. **Cancellation link** — identical construction to the authorize link, with `/auth` replaced by
   `/cancel_auth` (`https://open.shopee.com.br/cancel_auth` for Brazil production).
2. **Seller Center** — "Home Page > Platform Partner" for local sellers (button: "Separate");
   "Home Page > Open Platform Management" for CNSC/KRSC.

Either way you learn about it through `push 16` (§7).

---

## 2. Token exchange and refresh

### 2.1 GetAccessToken

`api v2.public.get_access_token` — **POST `/api/v2/auth/token/get`**, type **Public**.

- Production: `https://partner.shopeemobile.com/api/v2/auth/token/get`
- Sandbox (`guide 20`): `https://openplatform.sandbox.test-stable.shopee.sg/api/v2/auth/token/get`
- Sandbox (`api` reference `test_url`): `https://partner.test-stable.shopeemobile.com/api/v2/auth/token/get`
  — **the two disagree; see §3.5.**

Query string carries the common params (`partner_id`, `timestamp`, `sign`); the body carries the
request params. Verbatim from `guide 20`:

```
Query: https://partner.shopeemobile.com/api/v2/auth/token/get?partner_id=1000016&timestamp=1657263479&sign=9c685bc7e4a74e90f45fe1933f1d72b2d9705acda4093a9fb1ec7e2b57ccea2a
Body:  {"shop_id":54804,"code":"7867624d4e76616648544f6e52625557","partner_id":1000016}
```

**`partner_id` appears twice — once in the query and once in the body.** `guide 20` calls this out
explicitly ("This partner_id is put into the query" vs "…put into the request body").

Request params (`api v2.public.get_access_token`):

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `code` | string | REQUIRED | one-time, 10 min |
| `partner_id` | int64 | REQUIRED | in the **body** |
| `shop_id` | int64 | optional | **exactly one of** shop_id / main_account_id |
| `main_account_id` | int64 | optional | |

Response (`guide 20` shop-level sample):
```json
{"refresh_token":"456e416149664b76745a6a794156794a","access_token":"6a55746e61546f707579627656637464",
 "expire_in":13859,"request_id":"c040b886cfcabdfa5a23af51c595cd1b","error":"","message":""}
```

Response (`guide 20` main-account sample) additionally carries the fan-out lists:
```json
{"refresh_token":"684d42685667777868597a4477587455","access_token":"44776151594778486943647644745361",
 "expire_in":14344,"request_id":"9199e13ee74b22411498209cb5516e24",
 "merchant_id_list":[1001705],"shop_id_list":[33142,46154],"error":"","message":""}
```

Also documented on the API reference: `supplier_id_list`, `user_id_list`, and (added 2026-07-13)
`principal_id_list`.

### 2.2 RefreshAccessToken

`api v2.public.refresh_access_token` — **POST `/api/v2/auth/access_token/get`**, type **Public**.
(Note the endpoint names are counter-intuitive: *get* token lives at `/token/get`, *refresh* lives at
`/access_token/get`.)

Body: `refresh_token`, `partner_id`, and **exactly one** of `shop_id` / `merchant_id` / `supplier_id` /
`user_id` (/ `principal_id`). `guide 20`:

```
Body: {"shop_id":33142,"refresh_token":"684d42685667777868597a4477587455","partner_id":1000016}
```

Response:
```json
{"partner_id":1000016,"refresh_token":"417472546e73504949676279576c477a",
 "access_token":"646d474965714a696177764963775743","expire_in":14400,
 "request_id":"78e64d11cb6dec6f6669282839fca916","error":"","message":"","shop_id":33142}
```

### 2.3 Lifetimes

| Token | Lifetime | Source |
| --- | --- | --- |
| authorization `code` | **10 minutes, one-time** | `guide 20`, `api v2.public.get_access_token` |
| `access_token` | **4 hours**, reusable | `guide 16`, `guide 20`, both token APIs |
| previous `access_token` after rotation | **stays valid a further 5 minutes** | `guide 20` |
| `refresh_token` | **30 days**, **single use** | `guide 20`, both token APIs |
| authorization itself | ≤ 365 days, seller-chosen | `guide 20` |

**⚠️ `expire_in` unit is contradictory in the docs.** Both token APIs declare the field with
`type=timestamp` and describe it as "The validity period of the access_token, **in seconds**". Every
sample in `guide 20` is a duration (`13859`, `14344`, `14400` = exactly 4 h) — but the response sample
in `api v2.public.get_access_token` is `"expire_in": 1767001812`, an **absolute Unix timestamp**
(2025-12-29). `api v2.public.get_token_by_resend_code` declares it `int` and says "unit is second"
(sample `3600`). Defensive read: if `expire_in > 10^9`, treat as absolute epoch; otherwise as a
duration. Do not trust it blindly — anchor on the documented 4-hour constant.

### 2.4 Rotation, single use, and the main-account fan-out

`api v2.public.refresh_access_token`, definition, verbatim:

> "Refresh_token can be used **once only**, this API will also return a new refresh_token. Please use
> the new refresh_token for the next RefreshAccessToken call"

and on the field itself:

> "Each refresh_token is valid for 30 days, and **can only be used once** by either a shop_id or
> merchant_id or supplier_id or user_id."

So refresh tokens are **rotating and single-use**. **How many times can the same refresh token be
used? Once.**

**⚠️ The main-account fan-out is the subtlest rule in the whole flow.** `guide 20`, verbatim:

> "For the same main_account_id, the initial access_token and refresh_token obtained from
> GetAccessToken are **identical**. After calling the RefreshAccessToken API separately for each
> shop_id and merchant_id, each shop_id and merchant_id will generate its own independent new
> access_token and refresh_token.
> For example: 1. The initial access_token / refresh_token obtained from GetAccessToken is assigned to
> 7 shop_ids and 3 merchant_ids. 2. After the initial access_token expires, you use the initial
> refresh_token to call RefreshAccessToken, and obtain **10 independent sets** of access_token and
> refresh_token for each shop_id and merchant_id. 3. After this, shop_id and merchant_id will no longer
> share any access_token or refresh_token."

Read carefully: the **initial** refresh token from a main-account authorization is used **N times** —
once per shop and once per merchant — each call returning that subject's own independent pair. The
`guide 20` worked example shows the *same* `684d42685667777868597a4477587455` posted twice, for
`shop_id: 33142` and for `merchant_id: 1001705`, yielding two different new pairs. **This is a
documented, deliberate exception to "single use", scoped to the first refresh after a main-account
authorization.** After that first fan-out, every subject rotates independently and single-use applies
strictly.

**Concurrency: UNKNOWN — docs do not say.** Nothing in `guide 20` or either token API describes
behaviour when two refreshes race on the same refresh token, and there is no documented grace window
for a *refresh* token (the 5-minute grace is explicitly for the **access** token only). The
combination of single-use rotation, no documented grace, and no documented concurrency semantics means
**refresh must be serialized per subject** — a lost race plausibly burns the only refresh token and
forces the manual resend-code recovery of §2.6.

### 2.5 Errors on a spent or bad refresh token

From `api v2.public.refresh_access_token`:

| Error | Meaning |
| --- | --- |
| `error_auth` / "Invalid refresh_token." | the error-example JSON |
| `error_shop_refresh_token` | "Your refresh token is error ,please check refresh token or shopid." |
| `error_merchant_refresh_token` | "Your refresh token is error,please check refresh token or merchant_id." |
| `refresh_token_expired` | "Your refresh_token expired." |
| `shop_access_expired` | "Your access to shop has expired." (authorization lapsed) |
| `merchant_access_expired` | "Your access to merchant has expired." |
| `shop_no_linked` / `merchant_no_linked` | "Partner and shop has no linked." |
| `shop_banned` | "The shop account has been banned. Permissions for shop authorization and API calls have been suspended until the shop account is restored." |
| `supplier_access_expired`, `supplier_no_linked` | supplier equivalents |

**⚠️ The docs do not distinguish "already used" from "wrong value"** — both surface as
`error_shop_refresh_token`. You cannot tell a lost refresh race from a corrupted token by error code
alone. Distinguish `refresh_token_expired` (30 days elapsed) and `shop_access_expired` (the
authorization itself lapsed → needs the seller) from the generic case.

From `api v2.public.get_access_token`: `invalid_code` ("The code is expired or used or invalid"),
`invalid_shop_id`, `invalid_main_acount_id` (**sic** — the typo is in Shopee's error list).

### 2.6 Recovery when tokens are lost

`api v2.public.get_token_by_resend_code` — POST `/api/v2/public/get_token_by_resend_code`:

> "When you lost your access token or refresh token, you can go to authorization management page to
> resend code by yourselves."

`resend_code` is one-time and expires in 10 minutes. **"You can only use this endpoint in live
environment, we don't support in test-stable environment."** So this recovery path is
**untestable in sandbox** — it will be exercised for the first time in production, under pressure.

### 2.7 Per shop or per main account? Merchant tokens?

- Tokens are stored and rotated **per subject**: `shop_id`, `merchant_id`, `supplier_id`, `user_id`
  (`guide 20`: "The access_token and refresh_token corresponding to each shop_id / merchant_id /
  user_id / supplier_id must be **stored separately**").
- `main_account_id` is **only** an input to `GetAccessToken`; it is never a refresh subject.
- **Merchant-level tokens are cross-border only.** `guide 16`: "Currently, only Shopee cross-border
  merchants need to use Merchant API. **Local sellers do not need to use it.**"
  `api v2.merchant.get_merchant_info` restricts `merchant_region` to "**KR, HK and CN**".
  **⇒ For a Brazilian local seller, merchant APIs and merchant tokens are out of scope entirely.**
- Re-authorization refreshes both tokens (`guide 20`).
- `RefreshAccessToken` "must be called within the authorization validity period" (`guide 20`).

---

## 3. Request signing

### 3.1 The three base strings (verbatim from `guide 16`)

Concatenate the **API path (without host)** and the common params, **in strict order**, with **no
separators**:

```
Shop API:     partner_id + api_path + timestamp + access_token + shop_id
Merchant API: partner_id + api_path + timestamp + access_token + merchant_id
Public API:   partner_id + api_path + timestamp
```

Worked examples, verbatim from `guide 16`:

```
Shop API
  partner_id: 2001887
  API path:   /api/v2/shop/get_shop_info
  timestamp:  1655714431
  access_token: 59777174636562737266615546704c6d
  shop id:    14701711
  Base string = 2001887/api/v2/shop/get_shop_info165571443159777174636562737266615546704c6d14701711

Merchant API
  Base string = 2001887/api/v2/global_product/get_category165571443109777174636962737266615546704c6d1000000

Public API
  partner_id: 2001887
  API path:   /api/v2/public/get_shops_by_partner
  timestamp:  1655714431
  Base string = 2001887/api/v2/public/get_shops_by_partner1655714431
```

Then (`guide 16`, `guide 20`):

```
sign = lowercase_hex( HMAC_SHA256(key = partner_key, msg = base_string) )
```

"The output of the hash function is a **hex-encoded string**" (`guide 16`); `guide 20` adds
"**hexadecimal all-lowercase**". Example: `sign=56f31d01aeda9d08bf456b37f6f6640ef8614b4d6ad49baafe30b39a061f0e26`.

**The base string contains no request parameters and no body** — only the five (or three) common
values. The signature therefore does **not** protect the payload; it authenticates the caller and
bounds replay by timestamp only.

### 3.2 Timestamp window

**5 minutes** — stated identically in `guide 16` ("Each API request needs to be requested within 5
minutes of a timestamp"), `guide 20`, and the common-params block of every API reference page
("Expires in 5 minutes"). Unix seconds (`guide 16` example `1610000000`; the demos use
`int(time.time())`). `guide 747` lists "O horário do servidor está sincronizado" as a pre-ticket check
— clock skew is a known failure mode.

### 3.3 Where each parameter goes

`guide 16`:

- **GET APIs** — "you need to put **both** the common parameters and request parameters **in the URL**":
  ```
  https://partner.shopeemobile.com/api/v2/product/get_category?partner_id=851249&timestamp=1654673582&shop_id=1001094&access_token=367a0a8eb9d1837cbf7c43b587a0faa4&sign=a40fc50a08c382eeee08e2eb00deb8464c6fdcbe4f1c271e033cdbca3ded4d5b&language=zh-hans
  ```
- **POST APIs** — "common parameters in the request **URL**" and "request parameters in the request
  **body**":
  ```
  https://partner.shopeemobile.com/api/v2/shop/update_profile?partner_id=851249&timestamp=1654673582&shop_id=1001094&access_token=367a0a8eb9d1837cbf7c43b587a0faa4&sign=80cbce8da907d5a1237711409920fc16908a9f9e01b1254ff9cc44aaf0836122
  Body: {"shop_logo":"…","description":"TTest","shop_name":"123"}
  ```

**So `sign`, `timestamp`, `partner_id`, `access_token` and `shop_id` ALWAYS live in the query string,
for both verbs.** `Content-Type: application/json`; "HTTP/FORM for some certain APIs, for example, the
API for uploading files" (`guide 16`).

The token APIs are the exception that proves the rule: they are **Public** (so no `access_token` /
`shop_id` in the query and none in the base string) yet still take `partner_id` a second time **in the
body** (§2.1).

### 3.4 Production hosts

`guide 16` lists **three** production domains, chosen by **where your service is deployed**, not by the
shop's market:

| Domain | Intended for |
| --- | --- |
| `https://partner.shopeemobile.com/` | developers deployed near **SG** |
| `https://openplatform.shopee.com.br/` | developers deployed near **US** |
| `https://openplatform.shopee.cn/` | developers deployed near **Chinese Mainland** |

**⚠️ `openplatform.shopee.com.br` is a latency-routing endpoint for the Americas, NOT "the Brazil
API".** `guide 16` explicitly ties it to "developer who deployed their services near US", and `guide 14`
reinforces "Select the HTTP Address that corresponds to the server location where you want to call the
Open API". Meanwhile **every** worked example and cURL sample in `guide 20`, `guide 382` and the API
reference `url` fields uses `partner.shopeemobile.com` — including the Brazilian NF-e guide. Brazil
does **not** have a separate API contract; it has separate **portal** domains for the auth/cancel links
(`open.shopee.com.br`, §1.2). **Whether a token minted against one API host is valid against another is
UNKNOWN — docs do not say.** Pick one host and stay on it.

### 3.5 Sandbox hosts — the docs contradict each other

Three different sandbox hosts appear across pages read:

| Host | Where it appears |
| --- | --- |
| `https://openplatform.sandbox.test-stable.shopee.sg/` | `guide 644` (support table), `guide 20` (GetAccessToken / RefreshAccessToken "Sandbox Environment" rows) |
| `https://openplatform.sandbox.test-stable.shopee.cn/` | `guide 644`, for Chinese Mainland |
| `https://partner.test-stable.shopeemobile.com/` | the `test_url` field of **every** API reference page read |

Plus `https://partner.uat.shopeemobile.com/` in the generated cURL/PHP/Java samples of
`api v2.push.set_app_push_config` and `api v2.push.get_app_push_config`, and
`https://open.admin.shopee.io/` in the samples of `api v2.push.get_lost_push_message`. **Verify
empirically; `guide 644` is the most recently maintained prose (2025-09-16) and points at
`openplatform.sandbox.test-stable.shopee.sg`.**

Sandbox and production credentials are strictly separate: "Test partner ID can only be used in the test
environment, and Live partner ID can only be used in the production environment" (`guide 16`);
`guide 740` lists "Utilizar credenciais de Sandbox em chamadas para Produção (ou vice-versa)" as a top
common error.

---

## 4. Error envelope and rate limits

### 4.1 Envelope

`guide 16`, "API response parameters":

| Field | Always returned? | Meaning |
| --- | --- | --- |
| `request_id` | **Yes** | unique per request; required evidence for any support ticket |
| `error` | **Yes** | error code; **empty string on success** |
| `message` | No | error detail; empty on success |
| `warning` | No | "If the API call is successful, but **some data is not returned or some batch requests fail**, the information will be reflected in this field" |
| `response` | No | the payload on success |

```json
{"request_id":"b937c04e554847789cbf3fe33a0ad5f1","error":"","message":"","response":{"result":"success"}}
{"request_id":"b937c04e554847789cbf3fe33a0ad5f1","error":"common.error_auth","message":"Invalid sign","response":{"result":""}}
```

**⚠️ Success is `error == ""`, not HTTP 2xx.** And **`warning` is a silent partial-failure channel** —
a batch call can return HTTP 200 with `error: ""` and still have dropped rows, reported only in
`warning`. Any batch writer must read it.

**⚠️ The token APIs do NOT use the `response` wrapper.** `get_access_token` and `refresh_access_token`
return `access_token` / `refresh_token` / `expire_in` at the **top level**, alongside `error` and
`request_id` (§2.1–2.2). So do `get_shops_by_partner` (`authed_shop_list`, `more` at top level),
`get_merchants_by_partner`, `get_token_by_resend_code`, `get_shopee_ip_ranges` (`ip_list`) and
`get_shop_info`. The `push` APIs and most business APIs **do** use `response`. **A single generic
"unwrap `.response`" client helper will break on the auth endpoints.**

### 4.2 Common error codes observed

Recurring across `api v2.push.*`, `api v2.public.*`:
`error_param`, `error_data` ("parse data failed", "data not exist"), `error_auth`, `error_server`
("Something wrong. Please try later.", "error server"), `error_network` ("Inner http call failed"),
and the gateway guard `error_param: request not from gateway`. Prefixed forms appear too
(`common.error_auth`). Auth-specific codes are tabulated in §2.5.

`guide 745` names the three canonical failure classes with causes: **Wrong Sign** (bad partner key,
expired timestamp, signature miscomputed, "URL ou parâmetros utilizados de forma diferente do cálculo
da assinatura"), **Invalid Access Token** (expired / shop not authorized / token belongs to another
shop), **Permission Denied** ("O endpoint não faz parte da categoria do App criada").

`guide 735` gives the exact category error: `"This app type has no permission to this API"` — resolved
only by having chosen the right App Category at creation (§8.3).

### 4.3 Rate limits — the field exists but is empty

Every API reference page carries a `rate_limit` field. **Across all 14 assigned APIs (and ~130 more
present in the shared doc cache), the value is `[0, 0, 0]` or empty — never a real number.** The triple's
semantics are not defined on any page read.

**Documented per-partner QPS: UNKNOWN — docs do not say.** A grep for "QPS", "rate limit" and
"frequency limit" across guides 14/16/18/20/27/31/644/718/735/736/739–747/749 returns **nothing**.

What *is* documented is a throttle-shaped mechanism on a different axis — the **push** warning/disable
logic (§5.7) — and App-status penalties ("API calls restricted", `guide 14`). Assume undocumented
server-side limits exist and implement backoff on `error_server`.

---

## 5. Push mechanism

### 5.1 Transport

- **HTTP POST** to the configured callback URL (`guide 18`: "Shopee sends an HTTP POST request to the
  defined callback URL").
- **Content type: UNKNOWN — docs do not say.** No page read states the request `Content-Type`. The
  bodies are JSON in every sample and the verification recipe treats the body as a raw JSON string.
- Push carries **no `partner_id`/`sign`/`timestamp` query params**; authentication is the
  `Authorization` header alone (§5.2).

### 5.2 The `Authorization` header signature

`guide 18`, "Push Authorization", verbatim:

> "we have provided an authorization signature for each Push request, which can be located in the
> **Authorization field of the HTTP request header**"
>
> 1. "Use **URL, |, response.content** as the signature base string. E.g:
>    `'http://www.example.com/example/uri|{"shop_id": 123, "code": 1, "success": 1, "extra": "shop_id 123 is authorized successfully", "data": {"more_info": "more info"}, "timestamp": 1470198856}'`
>    Note that the **json.loads(response.content) method is not recommended**"
> 2. "Retrieve your **partner key** from your App details"
> 3. "Use the signature base string and partner key to generate the signature with the **HMAC-SHA256**
>    hashing algorithm. The output … is a binary string. This requires **hex encoding**."

Reference implementation, verbatim (`guide 18`):

```python
def verify_push_msg(url, request_body, partner_key, authorization):
    base_string = url + '|' + request_body
    cal_auth = hmac.new(partner_key, base_string, hashlib.sha256).hexdigest()
    return cal_auth == authorization
```

```go
func VerifyPushMsg(url, requestBody, partnerKey, authorization string) (result bool) {
    baseStr := url + "|" + requestBody
    h := hmac.New(sha256.New, []byte(partnerKey))
    h.Write([]byte(baseStr))
    calAuth := fmt.Sprintf("%x", h.Sum(nil))
    return authorization == calAuth
}
```

So: **`sign = lowercase_hex( HMAC_SHA256(partner_key, callback_url + "|" + raw_body) )`**, compared
against the raw `Authorization` header value — **no `Bearer` prefix, no scheme token; the header value
IS the bare hex digest.**

**⚠️ The body must be the exact raw bytes as received.** "json.loads … is not recommended" is the doc
telling you that re-serializing changes key order and whitespace and breaks the HMAC. Any framework
that parses JSON before you can capture the raw string will silently fail verification.

**⚠️ Which URL exactly is genuinely ambiguous.** The doc says only "URL", the example is a bare path
URL with **no query string** (`http://www.example.com/example/uri`), and the sample is `http://`, not
`https://`. It is not stated whether this is (a) the callback URL **as configured in Console**, (b) the
request URL as received, (c) with or without scheme/port/trailing slash, or (d) what happens when a
proxy rewrites the host. **UNKNOWN — docs do not say.** Practical guidance: use the **exact string
configured as the callback URL**, and log the header alongside your computed value on first
integration so the discrepancy is visible. Note the same partner_key signs both API calls and pushes.

Verification is described as "technically optional, but we strongly recommend".

### 5.3 Body envelope

There is **no single envelope**; the shape varies per push type. Observed (`push 15`, `push 16`,
`push 12`, `push 3`):

```jsonc
// push 15 — shop authorization, single shop
{"data":{"authorize_type":"shop authorization by user","extra":"shop id 600000 (SG) has been authorized successfully","shop_id":60011111,"success":1},"partner_id":2000002,"code":1,"timestamp":1660616278}

// push 3 — shopee_updates: shop_id at TOP level
{"code":5,"timestamp":1610000000,"shop_id":1231234,"data":{"actions":[…]}}

// push 12 — authorization expiry: NO shop_id, NO partner_id
{"code":12,"timestamp":1568606634,"data":{"merchant_expire_soon":[…],"shop_expire_soon":[…],"user_expire_soon":[…],"expire_before":1619740800,"page_no":1,"total_page":2}}
```

Common-ish fields: `code` (the **push code**, always present), `timestamp` ("Timestamp that indicates
the message was sent"), `data` (payload). `partner_id` appears on `push 15`/`push 16` but **not** on
`push 12`/`push 3`. `shop_id` sits at top level on `push 3` but **inside `data`** on `push 15`.

**⚠️ `code` is the `push_code`, which is NOT the `push_api_id` used in doc URLs.**
`shop_authorization_push` is `push_api_id=15` but arrives as `code: 1`; `order_status_push` is
`push_api_id=1` but arrives as `code: 3`. Routing on the wrong number silently mis-dispatches.

**⚠️ `push 16` samples contain `"shopid"` (no underscore)** in three of five examples
("Authorization expired", "abnormal shop status", "disconnected") while the parameter table documents
`shop_id`. Either the samples are stale or the wire genuinely differs by sub-case — **tolerate both
spellings.**

### 5.4 Event id, ordering, dedup

- **Event id: there is none.** No push payload read carries a message id, event id or delivery id.
  (`get_lost_push_message` has a `last_message_id`, but that is an internal cursor for the *recovery*
  API only — it is **not** present on the live push.) **UNKNOWN — docs do not say.**
- **Ordering: UNKNOWN — docs do not say.** No page read makes any ordering guarantee.
- **Dedup/idempotency guidance: none given.** The only related statement is `guide 18`'s "To avoid
  receiving repeated notifications … set up your callback URL to respond according to these HTTP
  response requirements" — i.e. duplicates are expected whenever your ack is not accepted.
- **⇒ At-least-once with no dedup key and no ordering.** Idempotency must be derived from the payload
  (e.g. `order_sn` + status) plus a re-fetch, which is what `guide 18`/`guide 746` prescribe anyway:
  "Push NÃO substitui API. O Push só diz: 'Algo mudou.' Depois disso o desenvolvedor chama a API
  correspondente" (`guide 746`).

### 5.5 Timeout, response contract, retries

Empirically swept across 20 push types (raw `push_timeout` / `push_guarantee` / `retry_strategy`):

| Push | code | timeout (s) | guarantee | retry_strategy (s) |
| --- | --- | --- | --- | --- |
| `shop_authorization_push` (15) | 1 | **3** | 0 | **[300, 1800, 10800]** |
| `shop_authorization_canceled_push` (16) | 2 | 3 | 0 | [300, 1800, 10800] |
| `open_api_authorization_expiry` (12) | 12 | 3 | 0 | [300, 1800, 10800] |
| `shopee_updates` (3) | 5 | 3 | 0 | [300, 1800, 10800] |
| `order_status_push` (1) | 3 | 3 | 0 | [300, 1800, 10800] |
| `order_trackingno_push` (2) | 4 | 3 | 0 | [300, 1800, 10800] |
| `return_updates_push` (32) | 29 | 3 | 0 | [300, 1800, 10800] |
| `package_fulfillment_status_push` (33) | 30 | 3 | 0 | [300, 1800, 10800] |
| `item_price_update_push` (25) | 22 | 3 | 0 | [300, 1800, 10800] |
| …14 more read, all identical… | | 3 | 0 | [300, 1800, 10800] |
| **`webchat_push` (10)** | 10 | **2** | **1** | **[1, 2, 3]** |

- **Timeout: 3 seconds** for every push an ERP cares about (2 s for webchat). Corroborated by
  `api v2.push.set_app_push_config`'s error text: "Shopee have sent a test push to this call back url,
  but we didn't get any response **in 3 seconds** with 2xx code".
- **Retries: 3 attempts after the first, at +5 min, +30 min, +3 h.** Total window ≈ 3.6 h, then the
  message is dropped into the lost-push queue (§6).
- **`push_guarantee` is `0` for every push except webchat.** **The meaning of this flag is UNKNOWN —
  docs do not say**; no page read defines it. Do not read `guarantee=0` as "may be silently dropped"
  *or* as "guaranteed" — but do note that the one push with `guarantee=1` also has a far more
  aggressive retry schedule, which is at least consistent with it meaning "delivery is pressed harder".

**⚠️⚠️ The response contract is the biggest trap in the whole API.** `guide 18`, verbatim:

> "set up your callback URL to respond according to these HTTP response requirements:
> - Includes a status code of **2xx**.
> - Includes an **empty body**."

and:

> "A **failed** Push is defined as Shopee Open Platform not receiving an HTTP response with a status
> code of 2xx **and an empty body** within the timeout period."

**A `200 {"ok":true}` counts as a FAILURE.** The conventional JSON ack that every other webhook
provider accepts will drive this integration's success rate toward 0% and trip the auto-disable in
§5.7. Return `204`, or `200` with a zero-length body.

### 5.6 Configuring callback URLs

Two equivalent routes, both **per App**:

1. **Console** (`guide 18`, `guide 746`): Push Mechanism page → select App → Set Push → enter callback
   URL → **Verify** → tick the pushes you want. "To verify the validity of your defined callback URL,
   Shopee will send an HTTP POST request to the callback URL."
2. **API** — `api v2.push.set_app_push_config` (POST `/api/v2/push/set_app_push_config`), a **Public**
   API taking `callback_url`, `set_push_config_on[]`, `set_push_config_off[]`,
   `blocked_shop_id_list[]`. Read back with `api v2.push.get_app_push_config`, which additionally
   returns `live_push_status` (`Normal` / `Warning` / `Suspended`) and `suspended_time`.

**One callback URL per App, for all shops.** `set_app_push_config` is a Public API keyed only by
`partner_id`, with a single scalar `callback_url` and no per-shop addressing; `get_app_push_config`
mirrors that. There is **no** per-shop callback URL anywhere in the docs. Filtering is negative only:
`blocked_shop_id_list`, **max 500 shops** (`guide 18`, `api v2.push.set_app_push_config`).

**⚠️ The push-code enum in `set_app_push_config` only covers 1–13** ("1=Shop authorization … 13=brand
register result"), but live push codes reach **47** (`package_info_push`). Whether newer pushes
(`return_updates` code 29, `package_fulfillment_status` code 30, `item_price_update` code 22) can be
toggled through this API is **UNKNOWN — docs do not say**; the Console may be the only route.

Validation errors worth pre-empting (`api v2.push.set_app_push_config`): "this callback_url is
invalid"; "Your app's callback_url is empty, please input a callback_url before you turn on push
config"; "**The call back url can not be Shopee intranet address**"; and the two test-push failures
(no response in 3 s / non-2xx).

**Sandbox pushes: yes, but canned.** `guide 644` §3.3: "The Push Mechanism in the Sandbox environment
is **different from the production environment**. It is **no longer necessary to use related operations
to trigger the push**. Enter the Test Call Back URL and click 'Verify and Save' … Just click '**Push
Test Data**' after the corresponding Push Mechanism to receive the test data." `guide 746` confirms
"O Push de Sandbox é independente da configuração de Produção."
**⇒ You can test your receiver's parsing and signature verification in sandbox, but you cannot test
event-driven delivery, ordering, retries or the lost-push queue.**

### 5.7 Warning / auto-disable

`guide 18`. Success rate = successful pushes ÷ total pushes, where "successful" means the strict 2xx +
empty-body ack within timeout.

| Condition | Consequence |
| --- | --- |
| > 600 pushes in past 6 h **AND** success rate < **70%** | warning email **every 30 minutes** until you recover above 70% |
| > 600 pushes in past 6 h **AND** success rate < **30%** | **subscription DISABLED**, notification email |

**⚠️ After re-subscribing: "You will NOT receive Push Mechanism notifications missed during the period
where your subscription was disabled."** Success-rate accounting restarts from the new subscription.
Status is visible in Console and via `get_app_push_config.live_push_status`.

### 5.8 App-type gating

`guide 18` tabulates which pushes each App type may receive. The two relevant rows:

- **ERP System** — all pushes **except Webchat Push (code 10)**.
- **Seller In-house System** — **all** pushes.
- Also: **Original** — all except Brand Register Result (code 13).

`guide 18` step 4 and `guide 14` step 4 both point at `api v2.public.get_shopee_ip_ranges` "For
developers with systems that only allow access for whitelisted IP addresses" — i.e. to allow-list
Shopee's **inbound** push sources (§10, opposite direction from the outbound whitelist).

---

## 6. Lost push recovery

`api v2.push.get_lost_push_message` — POST `/api/v2/push/get_lost_push_message`, **Public**.

Definition, verbatim:

> "Get the lost push messages that were **lost within 3 days** of the current time and **not confirmed
> to have been consumed**"

Response:

| Field | Meaning |
| --- | --- |
| `response.push_message_list[]` | "Returns the **earliest 100** lost push messages that were lost within 3 days … and not confirmed to have been consumed" |
| `…[].shop_id` | "**If it's a partner level push (such as code: 1, 2, 12), shop_id will not be returned.**" |
| `…[].code` | push code |
| `…[].timestamp` | "Timestamp that indicates the message **was lost**" |
| `…[].data` | "Main Push message data" — **a JSON STRING, not an object** |
| `response.has_next_page` | bool — "whether the lost push message to be consumed is more than 100" |
| `response.last_message_id` | int — "Specifies the **end entry** of data returned in the current call" |

Sample, verbatim — note `data` is a stringified copy of the **entire original push envelope**:

```json
{"error":"-","message":"-","warning":"-","request_id":"1f34a2c99335ffe85744d98e07fe7d41",
 "response":{"push_message_list":[{"shop_id":727720655,"code":3,"timestamp":1660123127,
   "data":"{\"data\":{\"items\":[],\"ordersn\":\"220810QSK8S7BX\",\"status\":\"PROCESSED\",\"completed_scenario\":\"\",\"update_time\":1660123127},\"shop_id\":727720655,\"code\":3,\"timestamp\":1660123127}"}],
  "has_next_page":false,"last_message_id":176610}}
```

`api v2.push.confirm_consumed_lost_push_message` — POST
`/api/v2/push/confirm_consumed_lost_push_message`, **Public**, body `{"last_message_id": 176610}`
("The last_message_id returned by v2.push.get_lost_push_message"). Returns only the bare envelope.

**Answers:**

- **Retention window: 3 days.**
- **Paging: cursor-by-acknowledgement, not by offset.** There is no `page_no`/`cursor` **input** —
  `get_lost_push_message` always returns the *earliest 100 unconfirmed*. The only way to advance is to
  **confirm**. `has_next_page` tells you to loop.
- **Is consuming required to advance? YES.** Without `confirm_consumed_lost_push_message` you will
  re-read the same 100 messages forever. This is the one place in the API where an ack is
  load-bearing.
- **⚠️ `confirm` is a WATERMARK, not a per-message ack.** It takes a single `last_message_id` — "the
  **end entry** of data returned in the current call" — so confirming acknowledges the **whole batch up
  to that id**. If message 47 of 100 fails to process and you confirm anyway, **it is gone
  permanently** (3-day window aside). Persist all 100 durably *before* confirming.
- **What counts as "lost": UNKNOWN — docs do not say.** No page read defines the predicate. The
  documented retry ladder ([300, 1800, 10800] s, §5.5) makes "exhausted all retries" the plausible
  reading, and `timestamp` is documented as "when the message **was lost**" — but the docs never say
  so, nor whether pushes dropped during a §5.7 **suspension** enter this queue (`guide 18` says those
  are simply never received, which suggests they do **not**). **Do not rely on this queue to cover a
  disable event.**
- **Rate limit: empty** on both APIs. Given the 3-day window, a sweep every few hours is the shape the
  design implies.
- **Not available in sandbox in any documented way** — `guide 644` lists only "Push Test Data".

---

## 7. Authorization pushes (15 / 16 / 12) and the "main account" concept

### push 15 — `shop_authorization_push` (code **1**)

"This push allows you to be notified once shops or merchants are authorized to your app."
`data` fields (all optional, presence depends on how the seller authorized):

`shop_id` · `shop_id_list[]` · `merchant_id` · `merchant_id_list[]` · `main_account_id` ·
`authorize_type` (string, e.g. `"shop authorization by user"`, `"merchant authorization by user"`) ·
`extra` (human-readable detail) · `success` (int).

The three documented shapes:
```json
{"data":{"authorize_type":"shop authorization by user","extra":"shop id 600000 (SG) has been authorized successfully","shop_id":60011111,"success":1},"partner_id":2000002,"code":1,"timestamp":1660616278}
{"data":{"authorize_type":"shop authorization by user","extra":"Shop has been authorized successfully","main_account_id":68272,"shop_id_list":[62000001,62000002,62000003,62000004],"success":1},"partner_id":2000002,"code":1,"timestamp":1660616631}
{"data":{"authorize_type":"merchant authorization by user","extra":"merchant id 600000 has been authorized successfully","merchant_id":600222872,"success":1},"partner_id":2000007,"code":1,"timestamp":1660616278}
```

### push 16 — `shop_authorization_canceled_push` (code **2**)

Same field set plus `user_id` / `user_id_list[]`. `authorize_type` carries the **reason**, and the five
documented values reveal that this push fires for far more than a deliberate revoke:

| `authorize_type` | Meaning |
| --- | --- |
| `"user cancel shop authorization"` | seller revoked (App or Seller Center) |
| `"user cancel merchant authorization"` | seller revoked at merchant level |
| **`"expiry"`** | "The authorization is expired." |
| **`"App status is abnormal"`** | "Shop ID … is currently **frozen**. The authorization cannot be completed." |
| **`"shop and main account is disconnected"`** | "Shop … is disconnected from the main seller account …" |

**⇒ De-authorization is not always the seller's doing.** Freezing and main-account disconnection
produce the same push, and the ERP must distinguish "seller left" from "shop temporarily frozen".
(Samples for the last three use the misspelled `"shopid"` — §5.3.)

### push 12 — `open_api_authorization_expiry` (code **12**)

"Push shops, merchants, and users whose authorization expires within a week." Partner-level (no
`partner_id`, no `shop_id`):

```json
{"code":12,"timestamp":1568606634,"data":{
  "merchant_expire_soon":[123123,123123,4342,3242342],
  "shop_expire_soon":[23213,243242,342343,42342345656,45345],
  "user_expire_soon":[368765104,368765105,368765106],
  "expire_before":1619740800,"page_no":1,"total_page":2}}
```

**⚠️ This push is PAGINATED** — `page_no` / `total_page` — so a single expiry event may arrive as
several HTTP requests, each of which must be acked, and a dropped page silently loses shops.
`merchant_expire_soon` in the sample contains a **duplicate** (`123123` twice) — de-duplicate.

`guide 18`: "Get notified **7 days in advance** … You can then contact the seller(s) to authorize your
App again."

### The "main account" concept

Synthesising `guide 20` (§1.5), `push 15` and `push 16`:

- A **main account** is a seller identity that owns **multiple shops** (and, cross-border, merchants).
  It is the login the seller uses to authorize many shops at once.
- It appears as `main_account_id` in the redirect (§1.4), as an input to `GetAccessToken` (§2.1), and
  as `main_account_id` inside auth push `data`.
- **It is never a token subject after the first refresh** (§2.4) — tokens fan out to `shop_id` /
  `merchant_id`.
- `guide 18` explains *why* these two pushes matter: "The 2 above-mentioned authorization webhooks are
  important for acquiring the applicable list of shop and merchant IDs when authorizations for multiple
  shops are revoked via the main account. **Without these 2 webhooks, the callback address only returns
  the main account ID.**"

Independent of pushes, the authoritative list is `api v2.public.get_shops_by_partner`
(`authed_shop_list[]` with `shop_id`, `region`, `auth_time`, `expire_time`, `sip_affi_shop_list`,
paged, `page_size` max 100). **Reconciling against this on a schedule is more robust than trusting any
`guarantee=0` push.**

---

## 8. Sandbox and go-live

### 8.1 Creating a sandbox partner and test shop

`guide 644` + `guide 744`:

1. Create the App in Console → you immediately get a **Test Partner ID and Test Key** (`guide 14`).
   App status is **Developing**.
2. Console → **Test Account — Sandbox v2** → create a test account. Choose **shop** (local or
   cross-border) or **Merchant** (CNSC main account + bound merchants/shops).
   `guide 644`: "It is recommended that developers create a test store corresponding to the service
   market" — for Brazil, a **local BR** test shop.
3. Authorize the test shop to the **test** partner_id using the sandbox auth link, e.g.
   `https://open.sandbox.test-stable.shopee.com/auth?auth_type=seller&partner_id=***&redirect_uri=…&response_type=code`.
   **Log in with a Sandbox account, not a live one** — otherwise "Account/Password Verification Failed".
   **OTP is always `123456`.**

`guide 744`: "Sandbox e Produção são ambientes **totalmente independentes**. Aplicações Sandbox
funcionam apenas com contas e lojas Sandbox."

### 8.2 What sandbox supports

`guide 644` support matrix: Console (create test shop, **create test order**, push test data); Seller
Center (global SKU, shop SKU, orders, ship order); Open API — **all** APIs for Product, Global Product,
Media Space, Order, Logistics, First Mile, Shop, Merchant; Push — "Supports receiving **some** push
test data".

**Orders: yes.** Console → Test Order → Create Test Order (pick shop, items, shipping option). Then the
lifecycle is driven **manually from Console**: "Pickup" → `SHIPPED`, "Deliver" → `TO_CONFIRM_RECEIVE`,
then `COMPLETED` after a delay. `Arrange Shipment` in Seller Center or
`/api/v2/logistics/ship_order` moves it to `PROCESSED` first.

**Documented sandbox limits:**
- "**Printing of receipts is not supported at the moment, please use Open API to print**" (`guide 644`).
- "After creating an order on the Console page, you need to **wait about 5 minutes**" (`guide 644`).
- "Please operate the shipment in the '**To Ship**' tab. The 'All' tab may not be able to operate."
- Pushes are **click-to-send canned data only** (§5.6).
- `get_token_by_resend_code` is **live-only** (§2.6).
- "The sandbox provides basically the same functions as online, but **only covers core scenarios**"
  (`guide 644`); `guide 735`: "ele **não replica integralmente** o ambiente de produção e, portanto,
  comportamentos divergentes, limitações e instabilidades podem ocorrer."

### 8.3 App types, categories and permissions

`guide 14`. App types: **ERP System**, Product Management, Order Management, Accounting and Finance,
Marketing, **Seller In-house System**, Customer Service.

Which **developer account** may create which App type (`guide 14`):

| App Type | ISV (Third-party Partner) | Registered Business Seller | Individual Seller |
| --- | --- | --- | --- |
| **ERP System** | ✓ | — | — |
| **Seller In-house System** | — | **✓** | **✓** |
| Product / Order / Accounting / Marketing | ✓ | — | — |

API permissions (`guide 14`):

| App type | API permissions |
| --- | --- |
| **ERP System** | **All API except Chat API and Ads API** |
| **Seller In-house System** | **All API including Chat API** |

`guide 740` states the BR-recommended pairing directly:
> "Registered Business Seller: App **Seller In-House System**
> Third-party Partner (ISV): App **ERP System**"

**⚠️ Counter-intuitively, "ERP System" is the WRONG App type for a company integrating its OWN shop.**
"ERP System" is for ISVs serving *third-party* sellers, requires an ISV developer account, and has
*fewer* permissions (no Chat). A seller building an in-house integration wants **Registered Business
Seller + Seller In-house System**, which gets the full API surface. `guide 739` confirms the practical
difference: Seller In-house System Apps get an **"Authorize" button directly in Console** (no
hand-built link), while "ERP System … funciona para aprovar lojas terceiras e não lojas próprias".

**⚠️⚠️ The category is IRREVERSIBLE.** `guide 740`, verbatim:
> "Cada 'App Category' possui APIs/endpoints próprios e **não há permissões manuais ou extras** de
> outros endpoints. Após criado, **não é possível alterar a categoria nem adicionar novas permissões**
> ao mesmo App. Caso precise acessar APIs de outra categoria, será necessário **criar uma nova
> aplicação**."

`guide 735` §1 repeats it and names the runtime symptom: `"This app type has no permission to this
API"`. **This is the highest-stakes irreversible decision in Phase 0.**

Each API reference page carries an `api_permission` array listing the App types allowed. All 14 APIs
surveyed include both `"ERP System"` and `"Seller In House System"`.

Other `guide 14` facts: max **10 Apps** per developer; an App may authorize shops from **different
markets**; **no limit** on number of shops; **v2.0 only** for new Apps.

### 8.4 Go Live

`guide 14` + `guide 741`:

1. App List → select App → **Go Live** → fill the form.
2. "Your App will be reviewed **24 hours** after submission." (`guide 14` Q4: cannot be expedited —
   "submit … at least 24 hours before the expected live date".)
3. On approval you get the **Live Partner_id and Live Key**.
4. Switch to live credentials **and** the production host; re-do authorization with the live
   partner_id.

Go Live form fields (`guide 741`):
- **Product Brief** — public product URL, test username, test password, brief introduction, UI
  screenshot. (**Shopee expects working demo credentials for your product.**)
- **Authorization Information** — Test Redirect URL Domain, Live Redirect URL Domain.
- **IP Address Whitelist** — APP IP Address Management (one IP per line) + Enable toggle.
- **Other IT Assets Declaration** — Database Servers, Other Servers.

App statuses and their production restrictions (`guide 14`): **Developing** (cannot be authorized,
cannot call production APIs) · **Online** · **New App authorizations restricted** · **API calls
restricted** · **Suspended** (existing authorizations are **removed**). Regardless of status, the Test
Partner ID keeps working in sandbox.

Keys can be **reset** in Console (Edit → Basic Information → Reset under Test Key or Live Key);
`guide 735` §6 references announcement 1192 on improvements to that flow. **Deleting an App
invalidates the Partner ID/Key and ALL existing shop authorizations** (`guide 14`).

### 8.5 SPI apps — not relevant here

`guide 749` covers **SPI Apps** (Seller Logistics, Swarm ERP, Brand Membership, Auto Parts
Installation), where **Shopee calls your endpoint** rather than the reverse. In Brazil the live one is
**Seller Logistics** (quotation service; channel IDs 90021 / 90025 / 90026). Swarm ERP is
**whitelist-only and visible only when Developer Region is CN or HK**. **Not applicable to a standard
BR marketplace integration**, but note it exists if seller-owned freight quotation is ever in scope.

---

## 9. Sensitive data and masking (Brazil)

### 9.1 The platform-wide gate

`guide 718`: "Shopee Open Platform safeguards sellers' business data and users' personal data
considered sensitive (**including customer name, phone number, email address, and address**). **By
default, sensitive data is masked.**"

Two eligibility requirements:

| Requirement | Who |
| --- | --- |
| **Penetration Test Report** | ISV developers serving **Thailand, Malaysia, Singapore, Philippines**, plus **CNCB** and **HKCB** ISVs |
| **IP Address Whitelisting** | **ALL developers** |

**⇒ Brazil is NOT in the pentest list.** A BR developer needs **only the IP whitelist** — a materially
lower bar. (Do confirm in Console, since the list is written as an enumeration of markets served, not
of developer domicile: an ISV *planning to serve* those markets is included.)

Pentest details, if ever needed: submitted under Personal Center → Account Information → Security
Reports & Certifications (developer account only, **not** member accounts); reviewed in ~10 working
days; must be **black-box**, cover the external attack surface, list all findings and confirm all
Critical/High remediated; **vulnerability scans alone are not accepted**; approval is valid **2 years
from the report's issue date**, and reports should be < 1 year old.

`guide 743` adds the BR framing: "Por padrão, informações sensíveis são retornadas **mascaradas**…
Para **todos os desenvolvedores**, é obrigatório declarar os IPs da aplicação e habilitar o IP Address
Whitelist."

If misconfigured: "sua aplicação poderá apresentar o aviso **Sensitive Data** no Console e determinados
campos serão retornados **mascarados**" (`guide 741`).

### 9.2 The Brazil NF-e masking rules — status-gated, and independent of the whitelist

This is the operative answer for NF-e. `guide 743` and, definitively, `guide 382`.

Buyer data is exposed **only** in these order statuses (`guide 743`):
**`INVOICE_PENDING`, `READY_TO_SHIP`, `PROCESSED`, `RETURN` / `REFUND`**
(shown as "TO_SHIP" and "R/R" in Seller Center). Affected APIs: `v2.order.get_order_detail`,
`v2.order.get_order_list`, via `response_optional_fields`.

`guide 382`, verbatim, splits by **the SELLER's own tax status**:

**Seller CPF (individual):**
- Only the buyer's **"Endereço"** (address), in `READY_TO_SHIP`, `PROCESSED`, `RETURN/REFUND`.
- **"'Nome', 'Número' de 'telefone' e 'CPF' do Buyer não será disponibilizado em nenhum status da
  order"** — never, in any status.

**Seller CNPJ (business):**
- **"Nome", "Endereço" e "CPF" do buyer** are provided, in `INVOICE_PENDING`, `READY_TO_SHIP`,
  `PROCESSED`, `RETURN/REFUND`.
- **"O 'telefone' do Buyer não será disponibilizado em nenhum status da order"** — phone is never
  available.

**⇒ Direct answer to "does masking affect buyer CPF/address for NF-e?":**
**For a CNPJ seller — which is the ERP case — buyer NAME, ADDRESS and CPF ARE available**, but only
once the order reaches `INVOICE_PENDING` or later. **Buyer PHONE is never available, in any status,
for any seller type.** NF-e emission must therefore not depend on buyer phone, and must not attempt to
read buyer identity before `INVOICE_PENDING`.

`guide 382` also notes "para vendedores CNPJ é necessário que seja adicionado a Nota Fiscal no pedido,
**exceto para pedidos com o parceiro logístico que não tem suporte a Nota Fiscal, como por exemplo o
Correios**" — NF-e upload is mandatory except on non-supporting carriers.

Supporting endpoints named in `guide 382` (outside this survey's slice, flagged for the order/fiscal
survey): `v2.order.get_order_list?order_status=INVOICE_PENDING` lists orders awaiting an NF-e;
`v2.order.get_order_detail` with `response_optional_fields=invoice_data` returns the bound
`invoice_data` (`number`, `series_number`, `access_key`, `issue_date`, `total_value`,
`products_total_value`, `tax_code`); and the NF total is computed from `v2.payment.get_escrow_detail`
as `original_price − seller_discount − discount_from_voucher_seller + buyer_paid_shipping_fee`
("apenas uma das formas de calcular").

**⚠️ The two mechanisms are independent.** The status gate in `guide 382` is a hard rule about *when*
data exists; the IP whitelist in `guide 718` is about *whether you are allowed to see it unmasked at
all*. Satisfying the whitelist does not unlock a pre-`INVOICE_PENDING` order.

---

## 10. IP allow-listing

**Two opposite directions are documented, and they are easy to conflate.**

### 10.1 Outbound — YOUR egress IPs (mandatory for unmasked sensitive data)

`guide 718`, `guide 741`, `guide 742`. In Console → App List → App → **Go Live** (or **Edit** if
already Online) → **IP Address Whitelist** → enter "the IP address(es) of the server(s) hosting your
application", one per line → toggle **Enable IP Address Whitelist** → Submit.

`guide 718`, verbatim: "⚠️ **Important: Once IP Address Whitelisting is enabled, API calls can only be
made from applications hosted on the declared IP address(es).**"
`guide 742`: "Após habilitar o IP Address Whitelist, **apenas os IPs declarados poderão realizar
chamadas às APIs da Shopee**. Caso sua infraestrutura seja alterada, será necessário atualizar os IPs
cadastrados."

Separately, **Other IT Assets Declaration** (`guide 741`) asks for Database Server and Other Server
IPs — an inventory declaration, not an enforcement list.

### 10.2 Inbound — SHOPEE's source IPs (optional)

`api v2.public.get_shopee_ip_ranges` (POST `/api/v2/public/get_shopee_ip_ranges`, Public) returns
`ip_list` as CIDR strings (sample `["1.1.1.1/24","2.2.2.212/24"]`). `guide 18` step 4 and `guide 14`
step 4: use it "For developers with systems that only allow access for whitelisted IP addresses" — i.e.
to allow **Shopee's push traffic into** your callback. Call it in the same environment you are running
(sandbox ranges from sandbox, production from production).

### 10.3 Implication for a serverless backend — the real constraint

**Is declaring outbound IPs required? It depends on one thing: whether you need unmasked sensitive
data.**

- **If yes** (and for a CNPJ seller emitting NF-e, §9.2 says buyer name/address/CPF are exactly that):
  the whitelist is **mandatory for all developers** (`guide 718`), and once enabled it becomes an
  **enforced allow-list on every API call**, not just the sensitive ones.
- **⚠️ A serverless backend with dynamic egress cannot satisfy this as-is.** Cloud Run / Firebase App
  Hosting egress from an ephemeral, rotating pool. Enabling the whitelist against such a deployment
  will cause **every** API call to fail, not just sensitive-field reads. **A static egress IP is a
  hard prerequisite** — i.e. a VPC connector plus **Cloud NAT with reserved static addresses**, with
  every Shopee-calling surface (App Hosting backend *and* any Cloud Function that calls Shopee) routed
  through it. **This is an infrastructure decision that must be made before Go Live, not after.**

**The docs do acknowledge dynamic IPs — but only for the IT Assets declaration, not the whitelist.**
`guide 14` FAQ Q5, verbatim:

> "Q5: If my system is using a **dynamic IP address**, how do I fill in the Declaration of IT Assets?
> A: You can select the option '**IP address(es) unavailable**' and add your reason below.
> ⚠️ Note: You're **strongly encouraged to use static IP addresses**. If you use dynamic IP addresses,
> we will request for **regular declarations of your IT assets** to perform security checks."

Q6: "Once your static IP address has changed, please update your IT assets in the Console." Q7: if the
IP list exceeds the text box, choose "IP address(es) unavailable" and submit the IT Assets form.

**⚠️ Read the scope carefully: the "IP address(es) unavailable" escape hatch is documented for the
Declaration of IT Assets (Q5's exact wording), NOT for the enforced IP Address Whitelist of
`guide 718`.** Whether a dynamic-IP app can obtain unmasked sensitive data through that escape hatch is
**UNKNOWN — docs do not say.** The safe plan is static egress.

**Number of IPs allowed / CIDR ranges accepted in the whitelist: UNKNOWN — docs do not say.**
`guide 741` says only "um endereço IP por linha", implying individual addresses rather than ranges —
relevant when sizing a Cloud NAT pool.

---

## Appendix A — consolidated constants

| Constant | Value | Source |
| --- | --- | --- |
| auth code TTL | 10 min, one-time | `guide 20` |
| access_token TTL | 4 h (14400 s) | `guide 16`, `guide 20` |
| old access_token grace after rotation | 5 min | `guide 20` |
| refresh_token TTL | 30 days, single use | `guide 20` |
| authorization max duration | 365 days (seller picks 7/30/90/180/365 or custom) | `guide 20` |
| expiry warning push | 7 days ahead | `guide 18`, `push 12` |
| request timestamp window | 5 min | `guide 16`, `guide 20` |
| push response timeout | 3 s (webchat 2 s) | `push *`, `api v2.push.set_app_push_config` |
| push retry ladder | +300 s, +1800 s, +10800 s | `push *` |
| push required response | 2xx **and empty body** | `guide 18` |
| push warn threshold | >600 pushes/6 h and <70% success | `guide 18` |
| push disable threshold | >600 pushes/6 h and <30% success | `guide 18` |
| blocked_shop_id max | 500 | `guide 18` |
| lost push retention | 3 days | `api v2.push.get_lost_push_message` |
| lost push page size | 100 (earliest first) | `api v2.push.get_lost_push_message` |
| Go Live review | 24 h | `guide 14` |
| max Apps per developer | 10 | `guide 14` |
| get_shops_by_partner page_size | max 100 | `api v2.public.get_shops_by_partner` |
| sandbox OTP | `123456` | `guide 644` |

## Appendix B — every UNKNOWN

1. **PKCE** — no `code_challenge`/`code_verifier` anywhere; absent from a table presented as complete.
2. **Concurrent refresh semantics** — no documented behaviour when two refreshes race the same
   single-use refresh token; no grace window documented for refresh tokens.
3. **Push `Content-Type`** — never stated.
4. **Which exact URL string** goes into the push HMAC base (configured vs received; query included?;
   scheme/port/trailing slash normalisation).
5. **Push event id** — none exists on the wire.
6. **Push ordering guarantees** — never stated.
7. **Push dedup/idempotency guidance** — never given.
8. **Meaning of `push_guarantee`** — the field is exposed (0 everywhere except webchat=1) but never
   defined.
9. **Definition of "lost"** for `get_lost_push_message`; and whether pushes dropped during a §5.7
   suspension enter that queue (`guide 18` implies not).
10. **Whether push codes > 13 can be toggled** via `set_app_push_config` (its enum stops at 13; live
    codes reach 47).
11. **Per-partner QPS / documented rate limits** — the `rate_limit` field is `[0,0,0]` on every API
    surveyed; no QPS figure anywhere.
12. **Which authorize-link format (A or B) is authoritative** for BR production today.
13. **Whether a token minted against one API host works against another** (SG vs BR vs CN hosts).
14. **Whether the "IP address(es) unavailable" option satisfies the enforced sensitive-data IP
    whitelist**, or only the IT Assets declaration.
15. **Max IP count / CIDR support** in the App IP whitelist.
16. **`expire_in` unit** — declared `timestamp`, described "in seconds", sampled both ways.

## Appendix C — top implementation traps

1. **`200 {"ok":true}` on a push is a FAILURE.** Must be 2xx **with an empty body**, within **3
   seconds**. Sustained violation auto-disables the subscription, and missed pushes are never
   redelivered. Return `204`.
2. **The App Category is irreversible** and dictates every permission. For a company integrating its
   own shop, the correct pairing is **Registered Business Seller + Seller In-house System** — *not*
   "ERP System", despite the name.
3. **Enabling the IP whitelist blocks ALL API calls from undeclared IPs**, not just sensitive-data
   reads. Serverless dynamic egress must be fronted by Cloud NAT with static IPs **before** Go Live.
4. **Push `code` ≠ `push_api_id`.** Route on `code` (auth = 1, cancel = 2, expiry = 12, order status
   = 3).
5. **Refresh tokens are single-use and rotating, with no documented concurrency story** — serialize
   refresh per shop, persist the new token before using the new access token.
6. **The main-account first refresh is a deliberate multi-use fan-out** of one refresh token into N
   independent per-shop/per-merchant pairs. Modelling tokens as strictly one-per-refresh will break
   multi-shop onboarding.
7. **`confirm_consumed_lost_push_message` is a watermark** — it acks the whole batch up to
   `last_message_id`. Persist all 100 before confirming.
8. **The push HMAC is over the RAW body string.** Capture raw bytes before any JSON parsing.
9. **`warning` is a silent partial-failure channel** on HTTP 200 with `error: ""`.
10. **The auth/token endpoints do not use the `response` wrapper** that the rest of the API uses.
11. **Buyer phone is NEVER available**; buyer name/CPF/address only from `INVOICE_PENDING` onward, and
    only for CNPJ sellers.
12. **Authorizations can be as short as 7 days** — the seller chooses. Never assume 365.
13. **`push 12` is paginated** (`page_no`/`total_page`) and its sample contains duplicate ids.
14. **`push 16` fires on freeze and main-account disconnection**, not only on deliberate revocation —
    and some samples spell the field `shopid`.
15. **`get_token_by_resend_code` is live-only** — the token-loss recovery path cannot be rehearsed in
    sandbox.
