# apps/shopee — CLAUDE.md

API-only Next.js app for the **Shopee Open Platform** sales channel. One App
Hosting backend per channel (ADR 0015), so its logs and deploy are isolated.
Runs on `:3009` in dev. Steps 1–3 and 10 of
`.master_plans/shopee/shopee-marketplace-integration.md` — **OAuth connect,
conta status, the access-token refresh, the cached taxonomy reads, and the
inbound push receiver with its Cloud Tasks queue, nested functions codebase and
weekly authorization-expiry sweep**. Nothing is published or written **to**
Shopee yet — nothing reaches the seller's catálogo, anúncios or pedidos. The
only state-changing calls the app makes are the OAuth exchange and the token
refresh, and both matter: the `refresh_token` is single-use and rotating.

## What lives here

- `app/api/marketplace/shopee/oauth/start/route.ts` — authenticated (Bearer ID
  token → `PERM.integracao.write`); mints the signed `state`, **persists the
  attempt BEFORE returning the consent URL** (#821), and answers
  `{ authorizeUrl }`.
- `app/api/oauth/shopee/callback/route.ts` — the OAuth redirect target, **no
  Bearer** (it is a browser redirect from Shopee) → verify the state → **redeem
  the attempt** → exchange → persist. ⚠️ **#1034**: verifying the HMAC is not
  enough — it proves integrity, not freshness-of-use, so a captured `state`
  would otherwise be replayable for its whole 10-minute window and a replay
  OVERWRITES the account's credential. `shopeeOauthState.consume` is the anchor
  that makes it single-use; it runs BEFORE the exchange and fails as `bad_state`.
- `app/api/marketplace/shopee/conta/route.ts` — `PERM.integracao.read`. Reports
  the **two clocks** separately (see below).
- `app/api/marketplace/shopee/taxonomia/{categorias,atributos,marcas,limites,limites/kit,variacoes,recomendacao-categoria}/route.ts`
  — the seven read-only taxonomy routes, all `PERM.integracao.read`, all
  `integracaoId`-scoped. See **Taxonomy reads** below.
- `lib/shopee/taxonomia/` — the layer behind those routes: `cache.ts` (seven
  `createReadCache`s + `taxonomiaCtx`), `categorias.ts` (the tree index and the
  three-valued leaf gate), `params.ts` (hand-rolled query readers → pt-BR 400s),
  `dto.ts` (the answer shapes and their projections), and one reader per
  operation (`atributos`, `marcas`, `limites`, `variacoes`, `recomendacao`).
- `app/api/health/route.ts` — `{ service: 'shopee' }`.
- `lib/shopee/env.ts` — the one place this app reads its **Shopee**
  configuration from the environment, and every read there is blank-guarded
  (`?.trim()` + a length check, never `??`) — the one exception is
  `shopeeSandbox()`, whose `=== '1'` treats a blank value as production by
  construction. ⚠️ It is **not** the app's only
  `process.env` reader: Firebase credentials are read in
  `lib/firebase/admin.ts` (a verbatim copy of the same singleton the six sibling
  channel apps carry, `??`-defaulted `FIREBASE_DATABASE_ID` included), the CORS
  allow-list in `proxy.ts`, the Cloud Tasks region/valve in
  `lib/shopee/shopeeTasks.ts`, and the nested `functions/` codebase. The
  blank-guard rule is enforceable precisely because it is scoped to the Shopee
  values. ⚠️ `SHOPEE_VARIATIONS_PATH`
  (optional, **not** a secret) lives here too and is deliberately NOT
  shape-validated: this module answers "what did the operator type", and the
  package's `normalizeApiPath` decides whether that is a usable API path —
  raising `ShopeeConfigError` that NAMES the variable. See **Taxonomy reads**.
- `lib/shopee/core/{shopee,credentialStore,tokenStore,respond,validationIssues}.ts`
  — the context loader (cached `integracao` doc, uncached credential,
  `getAccessToken` / `createShopClient`), the Firestore credential store, the
  error→HTTP mapper, and the Next-free Zod-path helper (kept Next-free for a
  future functions-bundle consumer — step 3's bundle does NOT import it: its
  graph reaches `core/contaCache.ts`, not `core/shopee.ts`/`tokenStore.ts`.
  `respond.ts` is NOT Next-free and stays out of any bundle).
- `lib/shopee/core/tokenStore.ts` — the leased access-token refresh (see **Token
  refresh** below). Its three transactions are inventoried in
  `packages/config-eslint/rules/firestore-transaction-inventory.test.js`, which
  is where the full race analysis lives.
- `lib/shopee/conta/{oauthState,shops,status}.ts` — the per-attempt record
  binding, the token-free connection oracle (`findAuthorizedShop`, plus
  `listarLojasAutorizadas`, which pages to `MAX_SHOPS_PAGES` and dedups by
  `shop_id` with FIRST sighting winning), and the conta wire shape.
- `app/api/webhooks/shopee/route.ts` — the push receiver. No Bearer, out of the
  `proxy.ts` matcher, **204 with an empty body** on every ack. See **Inbound
  push** below.
- `lib/shopee/notificacoes/{pushSignature,notificacao}.ts` — the push HMAC and
  this channel's `defineNotificationPipeline` binding: `parseNotificationBody`,
  the derived doc id, the dispatch table on **push code**, and the conta arms.
- `lib/shopee/shopeeTasks.ts` — the `processShopeeNotification` queue scheduler
  (`SHOPEE_TASKS_REGION ?? FUNCTIONS_REGION`, no default; the
  `SHOPEE_TASKS_DISABLED` valve → persist-for-the-sweep).
- `lib/shopee/core/contaCache.ts` — the two cached integração readers:
  `readConta` (by integração id, extracted out of `core/shopee.ts`) and
  `findIntegracaoByShopId`, which is what turns a push's `shop_id` into a conta.
  Token-free by construction — it touches `integracaoCollection` only.
- `lib/shopee/avisos/autorizacao.ts` — the ONE module in this app that speaks
  **microseconds** (`millisToMicros`, two call sites); every other signature is
  milliseconds. Raises `shopeeAutorizacaoExpirando` / `shopeeDesautorizado` and
  resolves both.
- `lib/shopee/conta/expiracaoSweep.ts` — `runShopeeAuthorizationExpirySweep`,
  driven weekly by the functions codebase and, scoped to named shops, by
  `push 12`. See **The authorization-expiry sweep** below.
- `functions/` — the nested Cloud Functions codebase (a deploy-artifact
  sub-build; see `functions/DEPLOY.md`). Covered by this app's
  typecheck/lint/test tasks. Mirrors `apps/mercado-pago/functions`.
- `scripts/oauth-url.ts` — dev-only: mints a consent URL without the web UI.
  **Never run by an agent** (root CLAUDE.md rule 8).

The platform-neutral Shopee core (signer, hosts, typed clients, wire schemas,
error taxonomy) lives in `@delfrance/integrations-shopee`. It holds no Firestore
and no `process.env`.

ℹ️ **No PKCE, and no flag for it.** Shopee's consent URL (`guide 20`, "Format A")
has five parameters and no `code_challenge` anywhere in the docs, so the stored
`codeVerifier` is permanently `null`. Do not add a `SHOPEE_PKCE_ENABLED` toggle:
a switch that pretends to turn on a mechanism the provider does not implement is
worse than its absence. The signed `state` is consequently the ONLY trust anchor
on the callback — the legacy Flutter app had none at all.

ℹ️ **Two clocks, never one.** The **authorization** (`expireTime`, 7–365 days) is
the seller's consent and is read WITHOUT a token via the Public-signed
`get_shops_by_partner`; the **access token** (`credencial.expiraEm`, ~4 hours) is
a refreshable detail. The legacy app rendered "Conectado" from the 4-hour one and
never read the other, so an authorization about to lapse looked identical to a
healthy conta until the day everything stopped. `conta` therefore answers
`connected: true` on a stale stored access token — and normally with `loja`
populated too, because the shop read goes through the token store and renews the
pair on its way in. `loja` degrades to `null` whenever `get_shop_info`
could not be read AT ALL: another instance holds the renewal lease, the grant
itself is dead, or the shop call simply failed (a Shopee error envelope, edge
HTML under the IP whitelist, a network drop, an unparseable body). ⚠️ So a null
`loja` does NOT imply a renewal problem — only `credencial.renovacaoFalhou` says
that, and a dead grant is reported through it rather than as a 4xx, because a 4xx
would throw away the very clocks this route read WITHOUT a token.

## Token refresh (`lib/shopee/core/tokenStore.ts`, step 2)

`getOrRefreshAccessToken` is the ONLY way to obtain an access token. Reach it
through the context — `ctx.getAccessToken()`, or `ctx.createShopClient()`, which
hands the package a **function** so a token that lapses mid-batch is renewed
rather than replayed dead. Never read `access_token` off the document to sign a
call.

**Fast path first.** One uncached read of `credenciais/current`; if the stored
token outlives `REFRESH_SKEW_MS` it is returned with zero writes, zero
transactions and zero provider calls. That is the overwhelmingly common case and
it must stay free.

**Otherwise: a lease that EXPIRES.** ADR 0011 rejected pessimistic leases for
general writes and it is right to — the balanço lock is this repo's own example
of a lock that cannot expire. Token refresh is the one override, for one reason:
Shopee's refresh token is single-use and rotating, so two instances that both
spend it do not merely write twice, they can burn the pair. Firestore's OCC
cannot prevent that on its own, because OCC arbitrates the WRITE while the
expensive act — `POST /api/v2/auth/access_token/get` — happens between two of
them. So OCC excludes the two callers that read the same version, and the stored
lease excludes the caller arriving after one of them committed.

The constants, and the invariant that ties them (a test pins it):

| constant | value | |
|---|---|---|
| `REFRESH_POLL_BUDGET_MS` | `3_000` | how long a waiting caller polls before answering 503 |
| `REFRESH_POLL_INTERVAL_MS` | `250` | between re-reads while it waits |
| `REFRESH_LEASE_TTL_MS` | `30_000` | before anyone may take the lease over |
| `REFRESH_SKEW_MS` | `60_000` | a token with less life than this is renewed |

⚠️ **`BUDGET < TTL < SKEW`, and both inequalities are load-bearing.** TTL below
the skew means a crashed or hung refresher's lease expires while the old token is
still nominally alive, so the takeover lands inside the window the skew reserved
instead of after the conta has already stopped working (`shopeeCall` has no
timeout, so a hung fetch is the crash case by another name). Budget below the TTL
means a caller that waited out the whole budget and tries once more is still
refusing to steal a LIVE lease — it answers 503 and lets its caller retry.

The lease is **never renewed**: a lock that renews itself cannot expire, which is
exactly what made the legacy Flutter `isRefreshing` flag fatal. A corrupt lease
(a non-string owner, a non-finite expiry) reads as NO lease, so a half-written
document can never freeze an account.

**FAQ 144 vs the API page.** Shopee's refresh API page says a refresh token "can
be used once only"; Shopee's own FAQ 144 ("refresh_token Backup Plan") says a
used one stays valid for four more hours and, re-sent, returns the **same** new
pair. The two readings disagree and nothing published settles it, so the design
serves both. The commit guard is the seam: it re-reads the document inside its
transaction and compares the **stored `refresh_token` against the one we spent**
— an identity comparison, not a clock, so rule 7's cross-unit trap cannot apply.
If they differ, a newer pair landed (a re-consent, or another instance) and OURS
is dropped, the stored token returned. Under FAQ 144 that costs one wasted call;
under "once only" it is what stops a second write burning a live pair. The
release path does the mirror image: it adopts a newer stored pair **before** any
terminal verdict is written, so a `refresh_token_expired` answered about a token
that has since been replaced cannot disconnect a healthy conta.

⚠️ **The accepted residual is a crash between Shopee's answer and the commit.**
The pair we were handed is lost, and once the lease TTL elapses the next caller
re-sends the OLD refresh token: that heals under FAQ 144 and forces a re-consent
under "once only". Narrowing the window further would mean writing before the
provider answers, which is a worse trade. When it does happen the operator sees
`credencial.renovacaoFalhou` on the conta screen and reconnects.

The authorization-expiry sweep watches the OTHER clock (the 7–365-day one) and
lives in the nested functions codebase — see below.

## Inbound push (`app/api/webhooks/shopee/`, `lib/shopee/notificacoes/`, step 3)

The receiver reads the raw body **once**, verifies the `Authorization` header —
a bare lowercase hex HMAC-SHA256 over `SHOPEE_PUSH_CALLBACK_URL + "|" + rawBody`
— and enqueues onto the `processShopeeNotification` Cloud Tasks queue. It writes
**no Firestore document on the happy path**. The resilience behaviour itself
(retry disposition, failures-only persistence to `notificacoesShopee`, the
durable-cursor sweep) is the SHARED core in `@delfrance/data/admin/notifications`
— see the `webhook-notifications` skill. Do not re-implement it here.

⚠️⚠️ **The ack shape is not a style choice.** `guide 18` defines a FAILED push
as "not receiving an HTTP response with a status code of 2xx **and an empty
body**". The JSON ack every other provider in this repo accepts — `200 {"ok":
true}` — counts as a FAILURE here, and a sustained failure rate first warns
(>600 pushes / 6 h, <70 % success) and then **auto-disables the subscription**
(<30 %), which loses everything not already in the lost-push queue. So every
answer is `new NextResponse(null, { status })` and a test asserts the body is
genuinely empty on all three 2xx exits.

The ladder, in order: config missing ⇒ **503** · bad signature ⇒ **401**, before
any enqueue · unparseable body ⇒ 204 (a retry will not parse either) · no
integer `code` ⇒ 204 · enqueue failed ⇒ persist `failed` ⇒ 204 · the persist
failed on a `ZodError` ⇒ 204 (drop) · any other persist failure ⇒ rethrow, 5xx,
Shopee redelivers.

⚠️ **The HMAC signs the CONFIGURED url byte for byte.** `shopeePushCallbackUrl()`
does not strip a trailing slash and must not start: a slash, a http/https
difference or a stray port changes the digest. Shopee's docs never say WHICH url
string they sign, so the receiver logs configured-vs-received (plus 8-character
digest prefixes, never a body, a `data`, a full header or a key) for the first
five deliveries per instance and for every mismatch thereafter. Delete that log
once live traffic has answered it.

⚠️ **Keyed on the push CODE, never `push_api_id`.** They differ, and not by a
constant: `shop_penalty_update_push` is code **28** and push_api_id **31**. The
dispatch table is the only place this is written down — codes 1 / 2 / 12 are the
conta arms, a listed handful `ack`, everything data-bearing whose owning step is
unbuilt **parks**, and an unlisted code parks too, which is the only signal a new
code appeared.

⚠️ **An unbuilt handler PARKS, it never DEFERS.** `defer` means a precondition
outside this system will clear on its own, and it costs a daily re-drive for
`MAX_TENTATIVAS_DEFERRED` days. Exactly one thing defers here: a **code 1**
naming ONE shop that maps to no active integração — a seller who has not
connected yet, and a re-drive that only RESOLVES rows. ⚠️ The same shape on a
**code 2** is ACKED, not deferred: there the defer is inverted, because the
event that clears the precondition (the operator connecting the shop) is the
event that makes the news false, and the re-drive would raise
`shopeeDesautorizado` for a shop that is authorized and syncing — with no stored
`relogioEvento` to reject it, since nothing was ever written.

Shopee ships **no event id**, so the doc id is derived per code from the
resource key inside `data` (`ordersn`, `item_id`, `return_sn`,
`package_number`, …), through the same `asDocId` guard ML uses — a missing
segment becomes `-`, never nothing, and `.`/`..`/`/`/`__x__`/>1500 chars refuse
into an auto id.

## The authorization-expiry sweep and the avisos inbox (step 3, P8)

`sweepShopeeAuthorizationExpiry` runs Mondays at 04:00 America/Sao_Paulo. It
enumerates the partner's authorized shops through the **Public-signed**
`get_shops_by_partner` — so it reads no token and never touches a
`/credenciais/` path — and for each shop that maps to an active integração:
`dias <= 30` raises the expiry aviso, anything above resolves it.
⚠️ `shopeeDesautorizado` is resolved on **both** branches, before that test:
being enumerated at all is proof the shop is authorized again (a de-authorized
shop leaves `authed_shop_list` entirely), and tying that row to the healthy
branch left a re-consent shorter than 30 days standing forever on a
`serverOwned` collection nobody can dismiss by hand.

**Weekly, not monthly, and that is load-bearing:** a 30-day warning window on a
monthly cadence can miss an expiry entirely (run on the 1st and see 58 days; the
next run sees it already expired).

The sink is Lucas's avisos inbox (#1543), reached through
`escreverAviso`/`resolverAviso` in `@delfrance/data/admin/avisos`. Three things
about that seam:

- **The chave carries NO `janela`** — one row per (conta, shop), forever. A
  window keyed on the expiry date would make the resolver compute a key that was
  never created, because a re-consent MOVES the date, so the row would stand
  past the 90-day retention sweep. A repeat bumps `ocorrencias` and refreshes
  `params.dias` without moving `criadoEm` (no nagging); a lapse after a resolve
  reopens with a fresh `criadoEm`.
- **The stamps are microseconds** and `lib/shopee/avisos/autorizacao.ts` is the
  only place that knows it. Everything upstream — the sweep, the push arms, the
  shops reader — is milliseconds.
- **The WEEKLY CRON omits `relogioEvento`; the `push 12` arm supplies it.** Both
  go through the same sweep body, which carries the clock as the optional
  `ExpiracaoSweepDeps.relogioEventoMs` and spreads it onto the aviso only when it
  is defined. `camposInformados` reads an absent optional as "I do not know" and
  a `null` as "set it to null", so passing `null` from the cron would RESET a
  watermark a real push had already advanced — and a reset watermark is a guard
  that never rejects anything again.

`push 12` (Shopee's own 7-day warning) runs the **same producer**: it dedups
`data.shop_expire_soon[]`, intersects with mapped integrações and re-runs the
sweep scoped to those shop ids. ⚠️ It cannot build the aviso from
`data.expire_before` — that is a BATCH cutoff, not a per-shop expiry — so the
scoped run re-reads each shop's real `expire_time`. One producer, two triggers,
one row.

`push 1` (re-authorization) RESOLVES both Shopee avisos for the shop; `push 2`
(cancellation) raises `shopeeDesautorizado` with `motivo` = the `authorize_type`
Shopee sent. Neither writes the conta document — the conta screen derives its
clocks live.

`shopeePushDegradado` / `shopeePushSuspenso` are declared but have no producer:
that monitor is step 4.

## Taxonomy reads (`lib/shopee/taxonomia/`, step 10)

Seven Shop-signed GETs on Shopee's `product` module — the category tree,
attributes, brands, item and kit bands, standardised variations, and category
suggestions — behind seven `createReadCache`s at `READ_CACHE_TTL.config`
(15 min). **Step 10 writes nothing**: no Firestore document, no index, no
ruleset, no migration-window item.

**Every cache key starts with `integracaoId`.** This is the one deliberate
difference from `apps/mercado-livre`'s `mlMetadataCache`, which keys a category
by its id alone — correct there, because ML catalog metadata is global. Shopee's
is not: the tree is served per shop and in the shop's region, and the item bands
are per shop AND per category (guide 209 §1.1/§6; every number on the page is a
SAMPLE). A key without the integração would serve one conta's price ceiling, DTS
band or brand page to another, silently, in the direction that publishes.

**The leaf gate has THREE values** (`ehFolha`): `folha` (`has_children === false`,
exact), `nao-folha`, and `desconhecida` — the id is not in this shop's tree,
which is a **404** (`SHOPEE_CATEGORIA_DESCONHECIDA`), never "has children".
Attributes, brands, variations and the KIT bands gate on it (a non-leaf answers
200-with-nothing and makes ZERO calls to the gated operation — `get_category`
itself is still read, once per cache window, because that is what the gate
consults); the ITEM bands do **not**, because `category_id` is documented
optional there and its absence is a real read (`scope: 'shop'`).

⚠️ **The whole ~10⁴-node tree never crosses our wire.** `get_category` is unpaged
and returns everything; it is indexed once per cache window and the categorias
route answers lookups over that index — roots, or one node with `pathFromRoot`
and `children`.

**Four contradictions in Shopee's own docs, each instrumented rather than
guessed** (the `hosts.ts` technique — settled by one live sandbox call, flipped
by one literal or one env var):

1. **The `get_variations` path.** The page's `path`/`url`/`test_url` say
   `/api/v2/product/get_variation_tree`; all four of its samples call
   `/api/v2/product/get_variations`. The package defaults to the samples and
   `SHOPEE_VARIATIONS_PATH` overrides it. The path is INSIDE the HMAC base
   string, so the wrong one fails as `error_sign`, which reads like a bad partner
   key — hence the `variacoes` route echoes `pathUsed`.
2. **`category_id_list` vs `category_ids`.** The parameter table says the first,
   the page's own cURL says the second. The app sends ONE category per call,
   which serialises identically under both, and logs `error_param` raw with the
   parameter name it sent.
3. **`gtin_limit`'s position.** The item page renders it as a SIBLING of
   `response` and ships no response sample. Both positions are declared;
   `lerLimitesDeItem` merges them (inner wins, both absent stays `null` and never
   `{}`).
4. **The language casing.** `get_category` spells it `pt-br`,
   `get_attribute_tree` spells it `pt-BR`. ONE constant
   (`SHOPEE_TAXONOMY_LANGUAGE = 'pt-br'`) goes to all three ops, so a wrong guess
   is one literal to flip and `error_invalid_language` is the signal.

**Values that are data, not absences:** `brand_id: 0` is Shopee's "No Brand"
(a choice the operator makes), `variation_option_id: 0` is the observed CUSTOM
option, `parent_category_id: 0` marks a root, and **`-1` on `days_to_ship_limit`
means "no pre-sale"** (guide 209 §4) — never clamped, and read by
`suportaPreVenda`, whose wrong-way default is `false`.

**The kit bands are their own.** `get_kit_item_limit` has its own path, its own
schema and its own numbers; the two pages disagree field by field, and only the
kit declares `support_pre_order` and `component_count_limit_of_single_model`.
⚠️ Do not confuse that boolean with the item route's derived `supportsPreOrder`.

**No auto-paging.** `get_brand_list` answers ONE page; `nextOffset` is Shopee's
cursor, echoed verbatim (it is not `offset + pageSize`), and the caller asks for
the next one.

**`brandshopee` is untouched, and stays the curated shortlist.** Shopee's brand
API is extremely slow, so the supported brands are registered once and read from
our own database — the produto's brand dropdown reads `integracao/{id}/brandshopee`,
the `marcas` route serves only the REGISTRATION picker, and the shortlist is
maintained from the conta screen (step 21) and re-validated at publish (step 11).

**Recommendations are OFFERED, never applied** (`applied: false`, #799), and a
suggested id absent from the tree degrades that ROW (`unresolved`, one log line)
while a failure of the TREE read surfaces. Limits failures surface too — a
FAILURE never degrades to `limites: null`, because step 11 must not publish
against hardcoded numbers. The only `limites: null` in the layer is the kit
route's non-leaf short-circuit, which pairs it with `leaf: false`.

`limparTaxonomiaShopee()` clears all seven caches at once, coarse on purpose:
the primitive has no prefix scan. ⚠️ **Correction (step 3):** an earlier revision
said `push 13` was where granularity would earn its keep. It is not — `push 13`
is the brand-register RESULT and the dispatch table `ack`s it, invalidating
nothing. Nothing in step 3 clears a taxonomy cache; whichever step first reacts
to a brand or category change is where the question comes back.

## Rules specific to this app

1. **No UI code** beyond the placeholder root page. Thin route handlers.
2. **Auth is per-endpoint**: Firebase ID token (`verifyCaller`) for
   `/api/marketplace/shopee/*`; the signed OAuth `state` for the callback; the
   `Authorization` HMAC over `callback_url` + raw body for the push receiver. No
   Firebase Auth user sessions, and no `verifyCaller` on the receiver — it is a
   server→server call from Shopee.
3. **All Firestore access via `@delfrance/data/admin/collections` handles** —
   raw `.collection()`/`.doc()`/`.collectionGroup()` is lint-banned (except the
   `lib/firebase/admin.ts` singleton).
4. **Secrets in Cloud Secret Manager** (`SHOPEE_PARTNER_KEY`,
   `SHOPEE_STATE_SECRET`). Never committed, and **never logged** — the partner
   key signs every call, and a `code` is a live credential until it is exchanged.
   A schema failure logs field PATHS, never the body: on the token endpoint that
   body IS the credential (#1015).
5. **CORS** is handled by `proxy.ts` (Next 16 middleware) for
   `/api/marketplace/*` only. The callback and the push receiver both sit OUT of
   the matcher already (no browser preflight) — step 3 needed no `proxy.ts` edit.
6. **Two apps, ONE code path.** Staging uses the ERP System **test** app against
   the sandbox hosts (`SHOPEE_SANDBOX=1`); production reuses the **live legacy**
   application against the production hosts. The difference is credentials and
   env, never a branch in code. ⚠️ `SHOPEE_SANDBOX` is therefore **opt-in**
   (exactly `'1'`), the OPPOSITE polarity of `MELHOR_ENVIO_SANDBOX`: an unset
   value on a deployed backend must mean production.

## Env added by step 3

Three, all in the repo-root `.env.example` (one root template set, #730) — none
of them a secret:

- **`SHOPEE_PUSH_CALLBACK_URL`** — the EXACT url registered in the Shopee
  console, used byte for byte inside the HMAC base string. Unset or blank ⇒ the
  receiver answers 503. One url per app; registering it is #1534.
- **`SHOPEE_TASKS_REGION`** — must equal the `FUNCTIONS_REGION` inlined into the
  functions bundle. No default: an unset value THROWS on the first enqueue
  rather than resolving to `us-central1` and dropping the task behind a 204
  (#1108). `apphosting.yaml` ships it blank on purpose until step 22 deploys the
  codebase — blank reads as unset, so today the enqueue throws and the sweep
  drains, which is loud and lossless.
- **`SHOPEE_TASKS_DISABLED`** — `'1'` puts the channel in sweep-only mode: the
  enqueue throws, the receiver persists each push as `failed`, and the 30-minute
  reprocess sweep drains it. Never a silent drop, and never a 5xx.

## CI

`ci-shopee.yml` carries exactly ONE suite job, `Shopee Cloud Tasks round trip`,
behind the unskippable `CI gate (shopee)`. It builds the functions artifact and
runs `*.tasks.test.ts` against firestore + functions + tasks emulators
(`firebase.shopee.tasks.json`, ports 8084/5003/9500).

⚠️ **This lane owns no exclusion, and that is the point.** Unlike
`ci-mercado-livre`, `ci.yml` still runs every `@delfrance/shopee-app` unit test
in `CI test` — unfiltered, no `if:`. So a skip here loses the emulator round trip
and nothing else. Do not add a `ci.yml` filter for this workspace without moving
the offline job into this lane in the same commit; an exclusion is a promise.

⚠️ **The suites are disjoint BY GLOB.** `vitest.config.ts` excludes
`**/*.tasks.test.ts` and `**/*.firestore.test.ts`; `vitest.tasks.config.ts`
includes only the first. A file matching NEITHER runs in NO job. The
`*.firestore.test.ts` half is listed before that lane exists — it is step 22's
(#1530) — precisely so nobody has to remember it then.

The lane is offline by construction: `vitest.tasks.setup.ts` throws when
`FIRESTORE_EMULATOR_HOST` or `CLOUD_TASKS_EMULATOR_HOST` is missing under
`CI`/`REQUIRE_EMULATOR` (a skipped suite exits 0 — vitest counts COLLECTED
files), and installs a fetch kill-switch on every non-localhost host. That last
one matters more here than for a channel with no sandbox: Shopee's refresh token
is single-use and rotating, so one unstubbed refresh burns a real account's
credential.

## Dev

```bash
cd ../.. && cat .env.example .env.secrets.example > .env.local && cd apps/shopee   # ONE root template set (#730) — fill in
pnpm --filter @delfrance/shopee-app dev   # :3009
curl http://localhost:3009/api/health
```

Set `NEXT_PUBLIC_SHOPEE_URL=http://localhost:3009` so apps/web targets this app.

The `/canais/shopee/[id]` panel (step 21a) is the normal connect path —
**Conectar conta** starts the OAuth round trip from the browser. The script
below is now the headless fallback for when there is no web UI to click
through:

```bash
pnpm --filter @delfrance/shopee-app oauth:url --project <projectId> --integracao <integracaoId>
```

Open the printed URL, log in with the sandbox shop, and the browser lands on
`/canais/shopee/<id>?shopee=connected`. Opening the same URL twice must land on
`reason=bad_state` — that is the single-use attempt doing its job. On the test
app, leave the sandbox redirect-URL domain EMPTY (Shopee then validates nothing)
or register `localhost`.

## Deploy

Firebase App Hosting, own backend, root `apps/shopee`. Env + secrets via the
Firebase console / Secret Manager. The nested Cloud Functions codebase
(`functions/`) deploys separately — see **`functions/DEPLOY.md`**, including the
three IAM roles the receiver needs before it can enqueue.
`firebase.shopee.deploy.json` shipped with step 3 and is **inert**: a config file
deploys nothing, running it is a manual coordinated human step (root CLAUDE.md
rule 8), and the ROLLOUT — plus `firebase.shopee.json`, `vpcAccess`, the real
`SHOPEE_TASKS_REGION` and flipping `implementado` — is still step 22 / #1530.

⚠️ An **ERP System** Shopee app has no console "Authorize" button, so
`oauth/start` (or the script above) is the only way to reach the consent page,
and the redirect URL's **domain** is registered per app in the Shopee console —
`https://<this-app>/api/oauth/shopee/callback`.

⚠️ **Static egress is a prerequisite, not a step here.** Shopee's IP allow-list
(master plan P2, option D: a VPC connector, a subnet, a firewall rule, a reserved
IP and a proxy VM) is migration-window infrastructure (root CLAUDE.md rule 8) —
see #1208 when that window is scheduled. `apphosting.yaml` carries no
`vpcAccess`, deliberately.
