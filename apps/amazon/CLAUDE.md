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
- `vitest.config.ts` (`pnpm test`, in `ci.yml`'s `CI test`) excludes `*.firestore.test.ts`
  and `*.tasks.test.ts`; `vitest.tasks.config.ts` (`pnpm test:tasks`) includes exactly those
  two and runs only in `ci-amazon.yml` (see "CI (step 3)"). A file matching neither glob
  runs in NO job (`estrutura.test.ts` pins both globs). `eslint.config.mjs` lints both
  suffixes and only lets them build raw Firestore refs.
- `next` is an exact literal in `package.json`, never `catalog:` or a range.

## Routes (steps 2 and 3)

| Method | Path | Permission | Read switch | Answers |
| --- | --- | --- | --- | --- |
| GET | `/api/marketplace/amazon/conta/[id]` | `PERM.integracao.read` | not gated (no Amazon call) | 200 `StatusContaAmazon` · 400 `AMAZON_ID_INVALIDO` · 404 `AMAZON_CONTA_NAO_ENCONTRADA` |
| POST | `/api/marketplace/amazon/conta/[id]/oauth/start` | `PERM.integracao.write` | 503 `AMAZON_CHAMADAS_DESLIGADAS`, no Firestore read | 200 `{ authorizeUrl }` · 400 · 404 · 500 `AMAZON_CONFIG_AUSENTE` (names only) |
| GET | `/api/oauth/amazon/callback` | public (outside the CORS matcher) | redirect `integracao_desligada`, nothing consumed | redirect to `${WEB_APP_URL}/canais/amazon[/<id>]?amazon=connected` or `?amazon=error&reason=<motivo>` |
| POST | `/api/webhooks/amazon` | public; the relay key (outside the CORS matcher) | not gated (no Amazon call) | EMPTY body: 503 config · 401 key · 500 failure not persisted · 200 everything else, every drop included |

Every answer carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`
(`lib/amazon/core/respond.ts`, `proxy.ts`, and site-wide in `next.config.ts`).
The callback's fifteen ordered steps live in `lib/amazon/conta/conectar.ts`; the
route is thin. `proxy.ts` allows `GET, POST, OPTIONS`.

## Receiver (step 3)

- `POST /api/webhooks/amazon` (= `CAMINHO_RECEPTOR_AMAZON`, the relay contract in
  `packages/schemas/src/relayAmazon.ts`) is THIN; `lib/amazon/notificacoes/receptor.ts` holds
  every decision, in order: config (503, nothing read) → relay key through the shared
  `verifyStaticSecret` (current AND previous, both always compared; 401, body unread) → body
  ≤ 2 MiB (`corpo.ts`: twice SQS's 1 MiB maximum — a bound on the read, never a filter on
  Amazon's input) → JSON → the `{ body }` wrapper → type + casing (`envelope.ts`: one parser per
  casing) → `ApplicationId` EXACTLY ours → routing fields by grammar → enqueue. Never a
  400/404/413 (D5). One `evento: 'notificacao'` line per delivery, with `chave: atual | anterior`
  after auth; never the seller id, the raw application id, a header or body text.
- The task payload is ids only, unknown keys STRIPPED, built field by field: a DECLARED departure
  from the `webhook-notifications` skill's `.passthrough()` rule (step-3 plan §3 decision 29;
  the body carries buyer data and the task re-fetches the order). Do not "fix" it.
- The enqueue races a 2-s deadline and the failure persist a 1.5-s one (`notificacoes/prazo.ts`),
  so the warm path answers inside the API destination's 5-s timeout (`prazos.test.ts`). A failed
  or late enqueue (the valve, a named transient, the deadline, a raw SDK error) is persisted as
  `failed` under `push:<NotificationId>` and answered 200; anything else is rethrown (500).
- ⚠️ `prazo.ts` holds the app's ONE consume-all: a rejection arriving AFTER its deadline answered
  is logged by class and dropped, because a rethrow there is an unhandled rejection that kills the
  instance. Rule 6 still applies everywhere else; do not "fix" that handler.
- The queue's composition root is `lib/firebase/filaLeitura.ts` (region with no default, the
  `AMAZON_TASKS_DISABLED=1` valve, `getFunctions(`); the receptor narrows SDK errors through
  `ehFalhaDoSdkDeTarefasAmazon` and DIRECTLY imports no SDK, context, conta read, park or Amazon
  client (`estrutura.test.ts`). Its import closure still reaches the context, the conta reads, the
  park and the package through `./notificacao` and `../env`; no receiver path calls them, and the
  happy path makes no Amazon call and no Firestore operation (`receptor.test.ts`, `prazos.test.ts`).

## Functions codebase (step 3)

- `functions/` is the nested Cloud Functions codebase `amazon` (NOT a workspace member: this
  app's tsconfig, `eslint .` and vitest cover it). `build.mjs` esbuild-bundles `src/index.ts`
  (externals: `firebase-admin*`, `firebase-functions*`; defines `FUNCTIONS_REGION` with no
  default, `FIREBASE_DATABASE_ID`, `TASKS_INVOKER_SA`); `scripts/prepare-deploy.mjs` writes
  `.deploy/amazon-functions`. `firebase.amazon.deploy.json` ships INERT: the deploy is W9, by a
  person, never an agent. `functions/DEPLOY.md` has the prerequisites, the commented-out runtime
  env and the IAM. ⚠️ The conta trigger `onIntegracaoAmazonChanged` stands outside both INERT
  switches: it makes no Amazon call and imports no importer, so deployed into a project it writes
  that project's `int_frete` on any Amazon conta save that moves a mirrored field. It deploys
  only after W12 (`functions/DEPLOY.md`).
- `src/index.ts` imports `./options` FIRST and ALONE and exports ONLY triggers:
  `filaLeituraAmazon` (the reads queue, = `FILA_LEITURA_AMAZON`, asserted at load),
  `reprocessAmazonNotifications` (both lanes, logged separately), `sweepAmazonExpirations`
  (the step-2 expiry body, daily, NO secret), `pollAmazonOrders` (the step-4 backstop poll,
  `src/pollPedidos.ts`) and `onIntegracaoAmazonChanged` (the step-20 conta trigger, NO secret).
  `index.test.ts` pins every option off `__endpoint`, in three families (schedules, queues,
  Firestore triggers), each exhaustive.
- ONE logger there too: every line is `registrarEventoAmazon(LOGGER_STDOUT_AMAZON, …)` — never
  `firebase-functions`' `logger` (Loja Integrada's root uses it; do not copy that), never
  `console.`, never an error message (a failed sweep row by document id only). The package
  errors reach the task wrapper's own "Unhandled error" log only through the pipeline's
  sanitizing boundary (`FalhaTarefaAmazonError`). `estrutura.test.ts` widens the `.message`,
  seller-id, `trechoCorpo`, `testing/` and conta-cache scans to `functions/src`. (The one
  declared exception is the shared core's warning on `incompleto`, from `packages/data`; see
  "int_frete binding (step 20)".)
- The two composition roots of the queue, `lib/firebase/filaLeitura.ts` (App Hosting, the
  receiver) and `functions/src/agendador.ts` (the step-4 poll), are the app's only `getFunctions(`
  callers; each reads the region as an object literal of STATIC `process.env` reads (esbuild's
  `define`). `src/tasksInvoker.ts` stays byte-identical to every other codebase's copy.

## CI (step 3)

- The emulator suites run only in `.github/workflows/ci-amazon.yml`: ONE job, `Amazon Cloud
  Tasks round trip`, behind the pinnable `CI gate (amazon)`. No `ci.yml` exclusion, so a
  skipped lane loses only the emulator suites. The lane landed in the SAME PR as its first
  suites (a suite without a lane runs nowhere); a new `*.tasks.test.ts` or
  `*.firestore.test.ts` now joins the same job with no workflow edit. Editing the workflow →
  the `ci-lanes` skill; `ci-lane-gates.test.js` pins its emulator command, switch and regions.
- The job: `prepare-deploy.mjs`, then `firebase emulators:exec --config
  firebase.amazon.tasks.json --only firestore,functions,tasks` (ports 8087/5005/9502; that
  file sits ONE DOT from `firebase.amazon.deploy.json`, the only one that deploys), then
  `pnpm test:tasks`. Run it locally the same way (JDK 21) with the job's env:
  `FUNCTIONS_REGION` = `AMAZON_TASKS_REGION`, `FIREBASE_PROJECT_ID=demo-erp`,
  `FIREBASE_DATABASE_ID=default`, `REQUIRE_EMULATOR=1`, `AMAZON_CHAMADAS=off`, a dummy
  `AMAZON_RELAY_SECRET` of 32+ characters and the placeholder `AMAZON_APPLICATION_ID`. On
  Windows the Firestore JVM can outlive `emulators:exec` and keep 8087: stop it after.
- D11 holds in the lane through TWO layers. The job env sets `AMAZON_CHAMADAS: 'off'` (the
  functions emulator inherits it, so a DISPATCHED function stops at the switch), and
  `vitest.tasks.setup.ts` refuses to start when the shell has it `on` or an artifact `.env*`
  file (anchored name) merely names it (`testing/guardaDaLaneDeTarefas.ts`, proved offline).
  Only code in the vitest process runs past the switch, with `ambiente` `on` as an object
  literal and an injected `fetch`: the resolve case of `notificacao.firestore.test.ts` (a
  fake importer, a refusing `fetch`; step-3 plan §3 decision 37) and the poll's two suites
  (`searchOrders` served by a scripted `deps.fetch`; `pollPedidos.firestore.test.ts`,
  `functions/src/pollPedidos.tasks.test.ts`).
- Every suite's `beforeEach` wipes what it reads (one shared emulator, files run serially), a
  drop is proved by a LATER sentinel row, never by polling for an absence, and an absence only
  after a positive read. The receiver races its enqueue against 2 s, so
  `route.tasks.test.ts` warms the Admin SDK and the functions emulator with one unraced enqueue
  first; a `failed` row with an `enfileiramento/…` reason there means the receiver's own
  fallback ran (a region mismatch, or that deadline).
- The lane cannot prove: Cloud Scheduler firing (`onSchedule` is ignored),
  `scheduleDelaySeconds` (firebase-tools#8254), `rateLimits`/`retryConfig` (pinned offline in
  `functions/src/index.test.ts`), index declarations, rules, the relay, or a trigger's
  `database` binding.

## Backstop poll (step 4)

- `pollAmazonOrders` (`functions/src/pollPedidos.ts`, `7,22,37,52 * * * *`, 300 s, no retry)
  binds the deps ONCE per tick; the body is `lib/amazon/pedidos/pollPedidos.ts`. A throw
  leaves the tick through `sanitizarFalhaDaTarefaAmazon` (the scheduler wrapper logs the
  message). `index.test.ts` pins tick budget 240 s < timeout 300 s < lease 360 s < the 900-s
  interval READ off the cron.
- Two gates, in order, each with ZERO Firestore operations: no importer in the seam (until
  step 5), then the read switch not exactly `on`. So no poll document, and no bootstrap
  anchor, can exist before W5.
- `pollPedidosAmazon/{contaId}`: `cursorMs` (ms, Amazon's `lastUpdatedTime`, capped at the
  drain's start − 5 min, advance-only, moved only after a COMPLETE drain with every row valid),
  `pendente` (a stopped drain, resumed byte-identical unless its token is 23 h old), `vistos`
  (orderId → µs, read straight from Amazon's ISO text; pruned to cursor − 25 min and 2,000),
  the lease, `falhasSeguidas`. A fresh window starts at cursor − 10 min. Units: never compare
  `cursorMs` with a `vistos` stamp without converting.
- A per-conta DEADLINE (min(200 s, what the tick has left) − 20 s), checked before every page
  and every enqueue: a slow Cloud Tasks ends the run `orcamento-esgotado` with what it handed
  off written, never killed by the timeout with nothing written. Never remove it.
- `searchOrders` has exactly ONE caller module (`pedidos/pollPedidos.ts`), across `lib/`,
  `app/`, `functions/src` and `scripts/` (`estrutura.test.ts`): a second caller spends the
  poll's ~5 tokens per tick. A W7 verification script must never call it while the poll runs.
- `amazonImportacaoParada` is raised only after the final write that stored its count LANDED,
  resolved by the next clean run, and closed by the expiry sweep's orphan pass once the conta
  is gone (clocked by the conta list's read time; a deactivated conta's row is a residue).
- **Re-bootstrap (W7, by a person; `functions/DEPLOY.md` has the steps):** a changed H is
  redeployed FIRST; then a manual lease (`execucaoId` `w7-manual` first, then `emExecucaoAteMs`
  ahead), re-read after 6 min, delete the three FIELDS `cursorMs`, `pendente` and `vistos`
  (never the document), release. The next lease anchors now − `AMAZON_POLL_LOOKBACK_H`
  (functions only, default 24, cap 720, invalid ⇒ `lookback-invalido`). Never "check no
  lease is held, then delete": a run already holding it re-derives its OLD cursor back over a
  cursorless doc. Changing H after a conta's first LEASE (whatever that run's outcome) does
  nothing for it.

## int_frete binding (step 20)

- The ONE binding is `lib/amazon/frete/intFrete.ts`: `syncIntFreteAmazon`, the shared core
  (`@delfrance/data/admin/frete`) bound to `VINCULO_INT_FRETE_CONTA.amazon` with ZERO options
  (no tolerant scan). Never build a second one: the trigger, step 5's importer and the window
  pass (W12) must all name the same doc. Freight tipo `amz` (never `amazon`); a new doc is
  `amz-<integracaoId>`; a migrated one (64-hex id) is adopted by `contaAmazonContaFreteAmazonOuterRef`.
- `functions/src/onIntegracaoAmazonChanged.ts`: `deveReconciliar(before, after)` is a COST
  filter (zero reads for any write that is not, and was not, an Amazon conta, or moves no
  mirrored field); the reconcile takes the conta id ONLY — never a snapshot or an event clock.
  One `evento: 'int-frete'` line per reconcile (field NAMES joined, never a value or the
  `nome`; WARNING on `incompleto`). No `try`/`catch`: Firestore/Zod errors reach the Eventarc
  retry.
- Step 5's importer reads the conta's freight doc with
  `syncIntFreteAmazon.buscarIntFreteDaConta(db, contaId, { apenasAtivo: true })` over RAW bodies,
  never cached (its answer feeds a write). Reconciliation never filters `ativo`.
- ⚠️ The declared departure from the one-logger rule: on `incompleto` the core also writes its
  own unstructured stderr warning (`[amazon] conta Amazon sem dados suficientes para criar o
  int_frete`, the conta id and field names only), from `packages/data`, where
  `estrutura.test.ts` cannot see it. One `incompleto` event therefore produces two WARNING
  lines. Routing it through an injectable logger is a core change for four channels.
- D11 by construction: `estrutura.test.ts` walks the trigger's whole import closure (type edges
  included) and pins it file by file; it may import the SP-API package as TYPES only.
- Emulator suites: the trigger fires on EVERY suite's `integracao` writes. A suite that seeds a
  COMPLETE Amazon conta (filial + `dataCadastro` + `nome`) becomes a trigger suite and must
  await the trigger's last write (`vitest.tasks.config.ts` has the three rules).

## Layout

- `lib/amazon/` is Next-free except `core/respond.ts`, never imports the `@/`
  alias, and never reads `process.env`: the environment is a PARAMETER
  (`env.ts`), so step 3's functions bundle can import it. `estrutura.test.ts`
  pins all of it.
- `lib/amazon/avisos/avisos.ts` is the ONLY module that converts a clock to microseconds
  (three conversion sites, counted by its test). The poll's order stamps are µs read
  straight from Amazon's ISO text (`pedidos/janelaPoll.ts`), never a converted clock.
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
  inside any `.info|warn|error(` call and any non-call writer (`registrarEventoAmazon`,
  `registrarChamadaBloqueadaAmazon`, `registrarValvulaAmazon`), and a `trechoCorpo` campo
  outside `log.ts`. The sweep's returned `erros[].erro` is the class name too.
- A new operation stays keys-only in the log (and refused as a fixture) until its step adds
  its table rows AND regenerates the committed leaf inventory, from the repo root:
  `node .master_plans/amazon/evidence/amazon-doc.mjs folhas --saida
  apps/amazon/lib/amazon/testing/especificacaoFolhas.json` (the cache or
  raw.githubusercontent.com, never the SP-API; `OPERACOES_FOLHAS` lists the operations).
  `redacao.test.ts` demands every inventory leaf be classified exactly once.

## Fixtures and captures (step 2b)

- **Agents never open a raw capture** (no `cat`, editor or file-reading tool): owner captures
  live outside every checkout and are read only by the sanitizer
  (`pnpm --filter @delfrance/amazon-app sanitizar --entrada <abs> [--dry-run]`); an agent
  reads its output and the fixtures. Capture protocol: `scripts/README.md`.
- Fixtures (`lib/amazon/fixtures/__wire__/`) come ONLY from the sanitizer, never by hand: the
  `fixture` profile of `core/redacao.ts` (the one redactor — never a second one), the keyed id
  faker (`sanitizacao/falsificacao.ts`, fakes are fixpoints) and both layers of
  `fixtures/piiScan.ts`. Any finding refuses the whole run. A label zip/ZPL/PDF is refused by
  its first bytes and never opened. New model examples: `amazon-doc.mjs exemplo` /
  `notif-exemplo` into a folder outside the checkout, then the sanitizer.
- Run `sanitizar --entrada <abs> --verificar <files>…` over every changed doc, fixture and the
  PR body draft before every push that touches docs or fixtures (public repo).
- The sanitizer's closure (`sanitizacao/`, `fixtures/`, `scripts/sanitizar.ts`) stays inside
  zod, `@delfrance/core/{wire,documents}` and `node:{fs,path,url,crypto}`; `estrutura.test.ts`
  pins it. `MINIMO_DE_FIXTURES` in `wireCorpus.test.ts` equals the committed count.

## Environment

Read by this backend: `AMAZON_LWA_CLIENT_ID`, `AMAZON_APPLICATION_ID`,
`AMAZON_OAUTH_REDIRECT_URI`, `WEB_APP_URL`, `ALLOWED_ADMIN_ORIGINS`,
`AMAZON_CHAMADAS`, `FIREBASE_PROJECT_ID` / `FIREBASE_DATABASE_ID` (optional), and
the Secret Manager pair `AMAZON_LWA_CLIENT_SECRET` / `AMAZON_OAUTH_STATE_SECRET`.
`AMAZON_LWA_SEGREDO_EXPIRA_EM` is read only by the expiry sweep, which runs in the
functions codebase (`sweepAmazonExpirations`). The receiver (step 3) adds the Secret Manager pair
`AMAZON_RELAY_SECRET` / `AMAZON_RELAY_PREVIOUS_SECRET` (the second only during a
rotation; each 32–512 visible ASCII, else 503) and, in `lib/firebase/filaLeitura.ts`,
`AMAZON_TASKS_REGION` (falls back to `FUNCTIONS_REGION`, no default, else 503; trimmed
by `requireRegion`) and `AMAZON_TASKS_DISABLED` (exactly `1`). Every other read above
is blank-guarded (blank = unset) and never trimmed; the valves and lists below are NOT
(only unset and `''` are empty). `apphosting.yaml` lists them as COMMENT rows only —
no `env:` block.

### Write valves and canary lists (step 2b, `core/valvulas.ts`)

- Eight names, all BLANK in the root `.env.example` and COMMENT rows in `apphosting.yaml`
  (never an `env:` row: a baked `off` could override a console flip):
  `AMAZON_MODO_{ESTOQUE,PRECO,NFE,AGENDAMENTO}` and `AMAZON_CANARIO_{ESTOQUE,PRECO,NFE,AGENDAMENTO}`.
  The functions codebase's `DEPLOY.md` declares the same eight, commented out.
- A valve is `off | dry-run | on`: only the exact `on` writes, only the exact `dry-run` diffs,
  anything else is off (nothing trimmed or folded; an unrecognised value logs a WARNING). A
  write also needs `AMAZON_CHAMADAS=on`.
- A canary list: unset or empty (`''`) = NO target; exactly `*` = every valid target, the
  only widening; otherwise `,`-joined `<contaId>:<sku>` (stock, price) or `<contaId>:<orderId>`
  (NF-e, scheduling), split at the FIRST `:`, matched by exact `Set.has`. A malformed entry
  lists nothing and is logged by POSITION only (a WARNING): spaces alone are one malformed
  entry, and so is `<contaId>:*` — there is no per-conta wildcard. A SKU with a space, a comma
  or a non-ASCII letter, or exactly `*`, is valid but not listable: it is written only at `*`
  (`alvo-nao-listavel` otherwise).
- A batch of stock or price is a feed ONLY under `on` + exactly `*` (`decidirLote`); under a
  list it sends patches for the canary targets alone. Either way every MEMBER still goes
  through `decidirAlvo`, and only members deciding `on` are sent: under `*`, an
  `alvo-invalido` member is left out of the feed and dry-runs.
- Order inside a write flow: `lerValvula` FIRST (reads its two names once, a snapshot for the
  run), `registrarValvulaAmazon` second (`evento: 'valvula'`), then `decidirLote` per batch and
  `decidirAlvo` for every member. No flow calls them yet; the write engine (step 14 PR a) is
  the first.
- W8 (the window, never before it), per flow: `dry-run` → a canary list → `on` → `*`, set ALIKE
  on both surfaces. Check the run-start line, then the dry-run diffs, then clean read-backs.

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
| Receiver, happy path | — | no write (the enqueue is the whole effect) |
| Receiver failure persist | 0 | the shared core's `create` on the deterministic `push:<NotificationId>`; ALREADY_EXISTS = already durable |
| Poll failure persist (step 4) | 0 | the same core `create` on `poll:<conta>:<orderId>:<µs>`; ALREADY_EXISTS = already durable |
| Poll refusal record (step 4) | 1 | `create`, or `update(…, { lastUpdateTime })` never while a lease is held; never the cursor or the lease |
| Poll lease (step 4) | 1 | `create`, or once EXPIRED `update(…, { lastUpdateTime })`; that update also anchors a cursorless doc (W7) |
| Poll final write (step 4) | 1 | `update(…, { lastUpdateTime: <lease writeTime> })`; on 9/5 re-read ONCE and RE-DERIVE (max cursor, merged `vistos`, our `pendente` only if `===` on its two scalars; no fold) |
| Conta cache | — | per-instance invalidate after the callback, by the intake task before a poll's `vendedor-mudou` drop (then a reload), and by the poll before each conta's run; others bounded by TTL + `isFresh` |
| `int_frete/amz-<id>` create (step 20) | 0 (inside the core's class-A reconcile) | `tx.create` at `amz-<id>`. On a miss, the lookup `tx.get`s that id inside the transaction, so a concurrent first reconcile conflicts (ABORTED, retried by the SDK) and re-derives `inalterado`. A stray ALREADY_EXISTS is NOT retried by the SDK: the trigger then rides the Eventarc retry (`retry: true`), and `--apply` stops and is simply re-run (idempotent) |
| `int_frete` mirror patch and deactivate (step 20) | A (the core's) | the shared core's ONE reconcile transaction (inventoried in `packages/data`): every input from its own `tx.get`s, no event clock, never a delete; this app adds no site |

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
