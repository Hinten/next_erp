# apps/shopee — CLAUDE.md

API-only Next.js app for the **Shopee Open Platform** sales channel. One App
Hosting backend per channel (ADR 0015), so its logs and deploy are isolated.
Runs on `:3009` in dev. Steps 1–2 and 10 of
`.master_plans/shopee/shopee-marketplace-integration.md` — **OAuth connect,
conta status, the access-token refresh, and the cached taxonomy reads**. Nothing
is published or written to Shopee yet, and step 10 writes no Firestore document
at all.

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
  channel apps carry, `??`-defaulted `FIREBASE_DATABASE_ID` included) and the
  CORS allow-list in `proxy.ts`. The blank-guard rule is enforceable precisely
  because it is scoped to the Shopee values. ⚠️ `SHOPEE_VARIATIONS_PATH`
  (optional, **not** a secret) lives here too and is deliberately NOT
  shape-validated: this module answers "what did the operator type", and the
  package's `normalizeApiPath` decides whether that is a usable API path —
  raising `ShopeeConfigError` that NAMES the variable. See **Taxonomy reads**.
- `lib/shopee/core/{shopee,credentialStore,tokenStore,respond,validationIssues}.ts`
  — the context loader (cached `integracao` doc, uncached credential,
  `getAccessToken` / `createShopClient`), the Firestore credential store, the
  error→HTTP mapper, and the Next-free Zod-path helper (step 3's functions bundle
  will reuse it).
- `lib/shopee/core/tokenStore.ts` — the leased access-token refresh (see **Token
  refresh** below). Its three transactions are inventoried in
  `packages/config-eslint/rules/firestore-transaction-inventory.test.js`, which
  is where the full race analysis lives.
- `lib/shopee/conta/{oauthState,shops,status}.ts` — the per-attempt record
  binding, the token-free connection oracle, and the conta wire shape.
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

**Not here:** the authorization-expiry sweep (the 7–365-day clock, P8) is
**step 3**, which creates the nested Cloud Functions codebase for the push
receiver anyway — an API-only App Hosting backend is the wrong place to grow a
scheduler.

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
the primitive has no prefix scan, and step 3's `push 13` is where granularity
earns its keep.

## Rules specific to this app

1. **No UI code** beyond the placeholder root page. Thin route handlers.
2. **Auth is per-endpoint**: Firebase ID token (`verifyCaller`) for
   `/api/marketplace/shopee/*`; the signed OAuth `state` for the callback; (step
   3) the `Authorization` HMAC over `callback_url` + raw body for the push
   receiver. No Firebase Auth user sessions.
3. **All Firestore access via `@delfrance/data/admin/collections` handles** —
   raw `.collection()`/`.doc()`/`.collectionGroup()` is lint-banned (except the
   `lib/firebase/admin.ts` singleton).
4. **Secrets in Cloud Secret Manager** (`SHOPEE_PARTNER_KEY`,
   `SHOPEE_STATE_SECRET`). Never committed, and **never logged** — the partner
   key signs every call, and a `code` is a live credential until it is exchanged.
   A schema failure logs field PATHS, never the body: on the token endpoint that
   body IS the credential (#1015).
5. **CORS** is handled by `proxy.ts` (Next 16 middleware) for
   `/api/marketplace/*` only. The callback — and the future receiver — stay OUT
   of the matcher (no browser preflight).
6. **Two apps, ONE code path.** Staging uses the ERP System **test** app against
   the sandbox hosts (`SHOPEE_SANDBOX=1`); production reuses the **live legacy**
   application against the production hosts. The difference is credentials and
   env, never a branch in code. ⚠️ `SHOPEE_SANDBOX` is therefore **opt-in**
   (exactly `'1'`), the OPPOSITE polarity of `MELHOR_ENVIO_SANDBOX`: an unset
   value on a deployed backend must mean production.

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
Firebase console / Secret Manager.

⚠️ An **ERP System** Shopee app has no console "Authorize" button, so
`oauth/start` (or the script above) is the only way to reach the consent page,
and the redirect URL's **domain** is registered per app in the Shopee console —
`https://<this-app>/api/oauth/shopee/callback`.

⚠️ **Static egress is a prerequisite, not a step here.** Shopee's IP allow-list
(master plan P2, option D: a VPC connector, a subnet, a firewall rule, a reserved
IP and a proxy VM) is migration-window infrastructure (root CLAUDE.md rule 8) —
see #1208 when that window is scheduled. `apphosting.yaml` carries no
`vpcAccess`, deliberately.
