# apps/amazon

API-only App Hosting backend for the Amazon (SP-API) marketplace channel, port 3011.

- The platform is called only through `@delfrance/integrations-amazon-sp-api`,
  never with a raw `fetch` here.
- **Mock only before the cutover (D11).** No code here calls Amazon until the
  window sets the read switch (`AMAZON_CHAMADAS=on`); tests run against the
  app-local fake db (`lib/amazon/testing/fakeDb.ts`), the in-memory attempt store
  (`fakeOauthState.ts`) and an injected fetch spy.
- The LWA authorization belongs to this integration alone, never the legacy
  app's (D10). Never put a token, the code, the client secret, the state, a
  seller id or a credential ref in a URL, a log line or a response.
- `vitest.config.ts` excludes `*.firestore.test.ts` and `*.tasks.test.ts`
  (emulator suites need their own lane — **none exists yet**, so the step that
  adds the first such suite must add `ci-amazon.yml` in the same change, or it
  runs nowhere while every check stays green); `eslint.config.mjs` still lints
  them and only lets them build raw Firestore refs.
- `next` is an exact literal in `package.json`, never `catalog:` or a range.

## Routes (step 2)

| Method | Path | Permission | Read switch | Answers |
| --- | --- | --- | --- | --- |
| GET | `/api/marketplace/amazon/conta/[id]` | `PERM.integracao.read` | not gated (no Amazon call) | 200 `StatusContaAmazon` · 400 `AMAZON_ID_INVALIDO` · 404 `AMAZON_CONTA_NAO_ENCONTRADA` |
| POST | `/api/marketplace/amazon/conta/[id]/oauth/start` | `PERM.integracao.write` | 503 `AMAZON_CHAMADAS_DESLIGADAS`, no Firestore read | 200 `{ authorizeUrl }` · 400 · 404 · 500 `AMAZON_CONFIG_AUSENTE` (names only) |
| GET | `/api/oauth/amazon/callback` | public (outside the CORS matcher) | redirect `integracao_desligada`, nothing consumed | redirect to `${WEB_APP_URL}/canais/amazon[/<id>]?amazon=connected` or `?amazon=error&reason=<motivo>` |

Every answer carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`
(`lib/amazon/core/respond.ts`, `proxy.ts`, and site-wide in `next.config.ts`).
The callback's fifteen ordered steps live in `lib/amazon/conta/conectar.ts`; the
route is thin. `proxy.ts` allows `GET, POST, OPTIONS`.

## Layout

- `lib/amazon/` is Next-free except `core/respond.ts`, never imports the `@/`
  alias, and never reads `process.env`: the environment is a PARAMETER
  (`env.ts`), so step 3's functions bundle can import it. `estrutura.test.ts`
  pins all of it.
- `lib/amazon/avisos/avisos.ts` is the ONLY module that speaks microseconds
  (three conversion sites, counted by its test).
- The conta cache (`core/contaCache.ts`) is token-free and used by the context
  loader ONLY; the credential is re-read uncached on every request.
- Routes never import the park (`core/estacionamento.ts`); step 3 is its first caller.

## Environment

Read by this backend: `AMAZON_LWA_CLIENT_ID`, `AMAZON_APPLICATION_ID`,
`AMAZON_OAUTH_REDIRECT_URI`, `WEB_APP_URL`, `ALLOWED_ADMIN_ORIGINS`,
`AMAZON_CHAMADAS`, `FIREBASE_PROJECT_ID` / `FIREBASE_DATABASE_ID` (optional), and
the Secret Manager pair `AMAZON_LWA_CLIENT_SECRET` / `AMAZON_OAUTH_STATE_SECRET`.
`AMAZON_LWA_SEGREDO_EXPIRA_EM` is read only by the sweep, which runs in the
functions codebase from step 3. Every read is blank-guarded (blank = unset) and
never trimmed. `apphosting.yaml` lists them as COMMENT rows only — no `env:` block.

## Rule 7, per write

| Write | Tier | Mechanism |
| --- | --- | --- |
| OAuth state `put` | 0 | full overwrite of `oauthState/current`; a newer attempt supersedes |
| OAuth state redeem | seam | the shared store's own atomic redeem, already inventoried in `packages/data` |
| `selling_partner_id` on the conta | 1 | `update(…, { lastUpdateTime })`, ≤ 3 re-decides (`conflito`); never `merge`/`set` |
| Consent credential | 0 | full `set`; a concurrent park/refresh is defused by identity (ref, `acessoRef`) |
| Access-token persist | 0 | field `update` of exactly `{access_token, expirationDate, acessoRef}` |
| Park | 1 | `update({reconexaoPendente}, { lastUpdateTime })`, ≤ 3 re-decides |
| Avisos | seam | `escreverAviso` / `resolverAviso`; the reconexão row always clocked (µs) |
| Conta cache | — | per-instance invalidate after the callback; others bounded by TTL + `isFresh` |

This app adds **zero** multi-document atomic-write sites.

## Departures from the step-2 plan (PR b)

- The start flow builds the consent URL BEFORE persisting the attempt (plan
  order: persist, then build), so a value the package refuses
  (`AMAZON_APPLICATION_ID`, `AMAZON_OAUTH_REDIRECT_URI`) answers 500 having
  written nothing. The attempt is still persisted before the answer.
- No `corpoMalformado()` in `respond.ts`: no step-2 route reads a body, and a
  fixed 400 would need a code outside PR a's closed `CODIGO_ERRO_AMAZON`.
- `prazos.test.ts` counts the code exchange in `lib/amazon/conta/conectar.ts`
  (1) and in the three route files (0 each): the callback route is thin and its
  body lives in `conectar.ts`.
- The context loader checks only the LWA pair (`lerAplicacaoLwaAmazon`), not the
  six connect-flow keys: a flow never builds a consent URL.
- An accepted refresh also resolves `amazonSegredoLwaRecusado` (the aviso table's
  "any successful LWA exchange"), best effort.
- "Present" is checked with the package's own `credencialLwaValida`, not just
  blank-guarded: the start refuses an LWA pair the exchange would refuse (500
  naming the key, nothing written), the callback's step 1 does too (LIST
  `config`, nothing consumed), and its step 5 treats a code outside visible ASCII
  as absent (`missing_params`, nothing consumed) — so no value refusable before
  `consume` can burn the attempt.
- `lib/amazon/core/valvulas.ts` carries a minimal `LoggerAmazon` interface and a
  `LOGGER_STDOUT_AMAZON` stdout sink (one JSON line, `severity` + `message`), and
  `loadAmazonContext` requires a `logger` dep. The plan defers every logger to
  step 2b (#1927); this is a stand-in so the switch's blocked line has somewhere
  to go. **Step 2b replaces it in place** — it must not add a second logger beside
  it.
- `tratarCallbackAmazon` returns `RetornoCallback` =
  `{ tipo: 'sem-web' } | { tipo: 'redirecionar', webBase, caminho, retorno }`
  (`caminho` is the list or the conta route from `ROTAS_AVISO`), not the plan's
  `{ destino: 'lista' } | { destino: 'conta', id }`: the route then needs no
  routing of its own.
- The switch's log classification counts only unset and the empty string as
  `ausente` (INFO); a whitespace-only value is `outro` and logs at WARNING — LI
  parity (`ehAusenteOuOff`), where the plan said "INFO when unset/blank/off". A
  stray space in the variable is a misconfiguration worth a warning.

See `.master_plans/amazon/amazon-marketplace-integration.md` (master plan, tracker #1923).
