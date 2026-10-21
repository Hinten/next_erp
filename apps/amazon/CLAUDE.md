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
- The logger stays LIGHT: the import closure of `core/log.ts`, `core/redacao.ts`,
  `core/formatoDaRef.ts` (the ref FORMAT, no import at all), `core/idConta.ts` (the
  conta-id grammar, no import at all; `core/contas.ts` re-exports it) and
  `core/valvulas.ts` never reaches `firebase-admin`, `@delfrance/data`, `next` or `@/`;
  `redacao.ts` imports only `zod` and `@delfrance/core/{wire,documents}`. `refCredencial.ts`
  keeps the hash and re-exports the format. `estrutura.test.ts` pins all of it.

## Logging (step 2b)

- ONE logger: `LoggerAmazon` in `core/log.ts`, campos PRIMITIVE only (a list is joined into
  one string at the call site). Routes hand in `LOGGER_STDOUT_AMAZON` (one JSON line on
  stdout, `severity` + `message` written AFTER the campos; every campo re-checked at run
  time by `camposSeguros`: masked, cut to 256 bytes, non-primitives `<nao-primitivo>`).
  Never `console.*`, never a second logger. A shared module that logs untyped campos
  (`escreverAviso`) gets the app's `warn` through `warnNaoTipado`.
- ONE line per Amazon call, built by `criarObservadorAmazon` and handed to the package's
  hook at EXACTLY three sites: the LWA refresh and the SP-API client (`core/contexto.ts`;
  callers pass `registro` — flow, attempt, task/notification ids — and the loader writes
  `logger` and `conta` LAST), and the code exchange (`conta/conectar.ts`). Only
  `core/log.ts` names the raw event type; `estrutura.test.ts` refuses any other observer
  (inline, forwarded, shorthand, combined, shadowed, renamed).
- The line is a projection (`CHAVES_DA_LINHA`, 26 keys): envelope by grammar, the redacted
  path + query, `credencial` (`lwa-acesso` / `lwa-refresh` / `lwa-codigo`), the ref's
  VERSION only, codes through the closed `CODIGOS_ERRO_AMAZON` (`<outro>` otherwise).
  NEVER in a line: a token, the client secret, the state, the code, a seller id (a path
  slot is `<sellerId>`), the ref or its fingerprint, an LWA body, a header, a raw query.
- The excerpt fails closed: no excerpt for LWA, for ANY 401/403, for a call without a ref
  version, or for a `segredo` path (RDT, client secret, `/documents`). Otherwise the
  allow-list walk of `redacao.ts` (path → template → table; denied subtrees/keys/prefixes
  win at any depth, any case; the regex layer runs PER LEAF on decoded strings, Amazon-made
  id leaves skip only the check-digit pass — a seller-typed one (SKU, alias, promotion,
  package ref) never does; mask first, cut to 2 KiB second). A non-2xx body keeps
  structure, booleans, `null`, integers below 1e7 and known codes only. Never widen a
  table, a code set or a key rule "to see the error".
- ⚠️ **The observer must never throw.** The package rethrows an observer's error in place
  of the outcome, and at the code exchange the state is already consumed: a throwing
  logger loses the seller's grant. `log.ts` and `redacao.ts` have no `catch` — they are
  total by construction; the totality matrix runs through all three real call sites.
- Never log `err.message` of an `AmazonError` (it embeds the path, which can carry a seller
  id): log `err.name`, the status and the codes. `estrutura.test.ts` refuses a `.message`
  inside any `.info|warn|error(` call and either non-call writer (`registrarEventoAmazon`,
  `registrarChamadaBloqueadaAmazon`), and a `trechoCorpo` campo outside `log.ts`. The
  sweep's returned `erros[].erro` is the class name too.
- A new operation stays keys-only in the log (and refused as a fixture) until its step adds
  its table rows AND regenerates the committed leaf inventory, from the repo root:
  `node .master_plans/amazon/evidence/amazon-doc.mjs folhas --saida
  apps/amazon/lib/amazon/testing/especificacaoFolhas.json` (the cache or
  raw.githubusercontent.com, never the SP-API; `OPERACOES_FOLHAS` lists the operations).
  `redacao.test.ts` demands every inventory leaf be classified exactly once.

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
