# apps/nfe — CLAUDE.md

Authoritative NF-e (Nota Fiscal Eletrônica) API host. API-only Next.js
app. Deploys to Firebase App Hosting. Talks to SEFAZ.

## Rules specific to this app

1. **Persist-before-send is mandatory.** Any new code path that talks
   to SEFAZ must write the NF-e doc to
   `pedidos/{pedidoId}/nfev4/{chave}` with `estado='enviando'`, the
   computed `chave`, and the signed `xml_assinado` **before** the SOAP
   request. This is the anti-loss anchor — see
   `lib/nfe/orchestrator/emitir.ts:emitirPedido` and the master plan's A8
   recovery section. Once SEFAZ authorizes, the write that persists
   `xml_nfe_proc` sets `xml_assinado: null` in the **same** patch
   (`swapAnchorForProc` in `lib/nfe/orchestrator/audit.ts`) — the
   `nfeProc` embeds the signed XML, so the anchor is replaced, never
   lost. Never clear `xml_assinado` any other way.
2. **No UI code.** Same shape as `apps/integrations`. The placeholder
   `page.tsx` exists only because Next requires a root route.
3. **Auth is Bearer `idToken` from Firebase Auth — every route, no
   exception.** Single guard: `lib/nfe/auth.ts:verifyCaller`. Required perm:
   - `PERM.fiscal.read`  → `consultar`, `consulta-cadastro`, `status-servico`,
     `danfe`, `carta-correcao/danfe`
   - `PERM.fiscal.write` → `emitir`, `emitir-lote`, `cancelar`, `inutilizar`,
     `carta-correcao`, `verificar`, `processar-pendentes`
   - `PERM.configuracoes.write` → `certificado` (POST/DELETE)

   There is **no OIDC service-caller path** — no `verifyServiceCaller`, no SA
   allow-list, no `/api/nfe/reconciliar` route. The async reconciler runs
   **in-process** in the `nfe` Cloud Functions codebase (`apps/nfe/functions/`),
   so every caller of these routes is a Firebase user. Don't re-introduce an
   HTTP reconcile endpoint: the Function → HTTP hop is precisely what was
   removed, and `auth.ts` states that contract at the top of the file.
4. **Cert-free boot, per-filial at every SEFAZ call.**
   `lib/nfe/runtime.ts:getNFeRuntime` is the process-level BASE singleton —
   it is **cert-optional**: it eagerly validates `NFE_AMBIENTE`/`NFE_UF` and
   loads the SEFAZ TLS chains (vendored under
   `packages/integrations/nfe/ca/sefaz-<uf>-<ambiente>.pem`; run
   `pnpm --filter @delfrance/integrations-nfe fetch:sefaz-ca`) but **never the
   cert** — the process boots with NO env cert. The env cert (`NFE_CERT_*`) is
   OPTIONAL, built lazily by `base.envRuntime()` only as the
   `NFE_CERT_ENV_FALLBACK` cert + the `/api/health` diagnostics.
   ⚠️ **One chain per TRANSPORT, and the contingency ones are LAZY.** The home
   SEFAZ chain is read at build time; `rt.svc('svc-an'|'svc-rs')` and `rt.an()`
   (the EPEC Ambiente Nacional drop-box) read
   `ca/sefaz-{svc-an,svc-rs,an}-<ambiente>.pem` only on **first use** — so a
   deploy or a CI job missing one boots green, passes every unit test, and
   throws `NFeRuntimeConfigError` (ENOENT) the first time contingency is
   actually activated. Nothing is checked in (`ca/.gitignore` ignores every
   `sefaz-*.pem`), so each slot must be fetched explicitly:
   `fetch:sefaz-ca --uf=AN --ambiente=homologacao`. That gap cost the
   monthly EPEC live lane every run it ever had (#1393); the guard is
   `packages/config-eslint/rules/sefaz-chain-fetch-coverage.test.js`.
   **Every SEFAZ call signs with the FILIAL's own A1**: orchestrator entry
   points take the base and call
   `lib/nfe/filial-cert.ts:resolveFilialRuntime(fs, baseRt, filialId)`, which
   reads `filiais/{filialId}/certificadoSecreto/default`, decrypts the private
   key with `NFE_CERT_ENC_KEY` (AES-256-GCM), and rebuilds the runtime via
   `deriveRuntimeForCert` (same chains, filial cert). The two filial-agnostic
   routes resolve the cert another way: `consultar` derives it from the emit
   CNPJ in the chave (`resolveFilialRuntimeByCnpj`), and `status-servico` takes
   a required `?filialId=`. SEFAZ enforces cert CNPJ = emitente CNPJ
   (rejection 213), so a single env cert can only emit for one CNPJ — hence
   per-filial. A filial with no stored cert throws unless `NFE_CERT_ENV_FALLBACK`
   is on AND an env cert exists (then it uses the env cert — tests/dev only).
   **An upload, rotation or removal reaches every instance within 15 min**
   (`CERTIFICADO_CACHE_TTL_MS` in `@delfrance/schemas`, the TTL of the
   `createCachedDocReader` in `filial-cert.ts`; #1680). The route evicts its own
   instance at once; the others — and the `nfe` Functions codebase — keep
   signing with what they had until the TTL, and the certificate screen tells
   the operator so. An unchanged certificate is re-read per TTL but keeps its
   decrypted key and keep-alive agent. Each verb writes the secret + the filial's `certificado` in ONE
   `WriteBatch` (an unknown filial is a 404, never a stub doc), and the upload
   carries a `lastUpdateTime` precondition from the read its CNPJ check used
   (409 `FILIAL_ALTERADA`, #1680).
   Upload/remove via `POST`/`DELETE /api/nfe/certificado` (`PERM.configuracoes.write`).
   **Losing `NFE_CERT_ENC_KEY` = all stored filial certs become undecryptable**
   (re-upload required) — treat it as a secret.
5. **Every Pedido item needs a resolvable `imposto`.** At emission,
   `preResolveImpostos` runs the Flutter-parity resolver cascade
   (`lib/nfe/imposto-resolver.ts`: item-stamped → `produtos/{id}/imposto`
   → `categorias/{id}/imposto` → `operacao/{id}/regras` → operação
   default) for every item whose `imposto` is missing **or fails the
   engine `impostoSchema`** (an invalid stamp is re-resolved and
   replaced — #398). When nothing resolves, emission fails loudly:
   `NFeMissingImpostoError` (absent) or `NFeOrchestratorError` naming the
   bad sub-field (invalid stamp) — no silent fallback. An `imposto` that
   passes `impostoSchema` but fails a build-time tribute guard (e.g. a
   partial ICMSSN900/500 group, a draft `configuracaoIBSCBS` with RTC
   on, or any `configuracaoISSQN` — the ERP emits no `ISSQNtot`, so the
   NF-e conjugada is refused, #1656) is **not** re-resolved: it fails as
   `NFeOrchestratorError` naming pedido/item/produto (400; batch errorCode
   `'NFeOrchestratorError'`) with no número consumed (#506) — single path:
   inside the allocation tx, generated before its first write; batch: a
   pre-flight after prep whose verdict `runChunkAllocateTx` applies before
   counting the member. ⚠️ Only a pedido that would GENERATE may fail on it —
   never pre-flight in `prepareEmission`: a bloqueada / in-flight nRec /
   EPEC-approved / crash-window nfev4 doc must return or retransmit as before,
   whatever the live config now says. The subcollection
   names are the LEGACY Flutter wire names on purpose (#423) — the migrated
   corpus carries those names, so legacy tax config resolves natively (scope keys:
   produto = typo `impostoOpercaoOuterRef`, categoria =
   `impostoCategoriaOperacaoOuterRef`; regra docs may carry UPPERCASE
   `CFOP`, path-shaped arrays and free-form NCMs — readers normalize).
6. **Per-Filial `NFeConfig` doc must be seeded before emitting.** The
   `serie`, `numeracao_atual`, and `idLote` counters live at
   `filiais/{filialId}/nfeconfig/default`. The orchestrator allocates
   the next `nNF` + `idLote` transactionally via the library's
   `nextNumeracao` + `nextIdLote` helpers; missing config is
   `NFeConfigNotFoundError`. Seed shape: `{ numeracao_atual: 0, serie:
   1, idLote: 0, ambiente: '2' }` for a fresh homologação setup.
7. **No magic-string fallbacks.** Every CFOP / NCM / unidade / cProd
   / xProd field MUST come from real data. The orchestrator throws on
   missing fields with a message naming the exact pedido / produto /
   item. The only SEFAZ-mandated literal kept is `'SEM GTIN'` for
   products without a barcode.
8. **`NFE_ALLOW_PRODUCAO=true` is required for produção.** Two guards reject
   `tpAmb='1'` without it: `assertSafeTpAmb` at the `generateNFe` entry, and
   `assertSafeTpAmbForTransport` immediately before every SEFAZ POST. Set
   only in the produção App Hosting backend. ⚠️ Only the generator one has a
   `NODE_ENV='test'` passthrough — the transport one deliberately has none,
   because `nfe-live` runs the live homologação suites through Vitest, so a
   test escape there would disable the guard in the one job that reaches SEFAZ.
   A third transport guard, `assertSafeEndpointForTransport`, judges the URL
   rather than the label: a produção-only SEFAZ host is refused unless
   `NFE_ALLOW_PRODUCAO=true`, and a `tpAmb='2'` call aimed at one is always
   refused. ⚠️ Both NF-e `vitest.config.ts` files pin `NFE_AMBIENTE=homologacao`
   and `NFE_ALLOW_PRODUCAO=''` AFTER the `.env`/shell spreads, so no Vitest run
   can reach produção from a local `.env.local`; a test needing produção
   semantics uses `vi.stubEnv` inside the test.
9. **Never log raw error objects or cert/XML-bearing values in NF-e code
   paths; never read `NFE_CERT_*` env vars outside the unified loader.**
   Use `safeErrorShape(err)` for catch blocks and
   `safeLog` / `redactSensitive` (from `apps/nfe/lib/nfe/log.ts`) for
   composite-object logging. Use `loadCertificateFromEnv()` /
   `hasNFeCertEnv()` (from `@delfrance/integrations-nfe`) for any
   cert-env interaction. **Enforced by ESLint** in
   `apps/nfe/eslint.config.mjs` + `packages/integrations/nfe/eslint.config.mjs`
   — raw `console.*` in NF-e code paths (`lib/nfe/**`, `app/api/nfe/**`,
   `src/{cert,soap,sign,generator,operations}/**`) and any
   `process.env.NFE_CERT_*` read outside
   `packages/integrations/nfe/src/cert/index.ts` are lint errors. Why:
   `NFeTransportError` carries `responseBody` (raw SEFAZ SOAP reply,
   can echo signed XML on cStat=215/225); `NFeCertificate` carries
   `privateKeyPem` + `pfxBuffer` + `password`; the cert env vars are
   sensitive secrets. Partial / mutated leaks bypass the GitHub Actions
   value-masker.

## Required env

```
FIREBASE_PROJECT_ID
FIREBASE_SERVICE_ACCOUNT_PATH       # or FIREBASE_SERVICE_ACCOUNT (inline JSON)
FIREBASE_DATABASE_ID=default

NFE_AMBIENTE=homologacao            # or 'producao'
NFE_UF=SP
# NFE_CERT_PATH=./.ignore/cert.pfx  # OPTIONAL — or NFE_CERT_BASE64 (health + fallback only)
# NFE_CERT_PASSWORD=...             # required iff a cert above is set
NFE_CERT_ENC_KEY=...                 # base64 32 bytes (openssl rand -base64 32) — encrypts filial keys
# NFE_CERT_ENV_FALLBACK=1            # filial w/o stored cert → use the env cert (tests/dev). Default off.
# NFE_ALLOW_PRODUCAO=true            # only if NFE_AMBIENTE=producao

# Async reconciler — a Firebase Functions task queue (`reconciliarNfe`),
# auto-provisioned on deploy. There is NO queue-path / endpoint / runner-SA env:
# the queue is named after the function and the enqueue is authenticated by the
# Admin SDK. Both vars below are OPTIONAL — the reconciler works unset.
# NFE_TASKS_REGION=<region>          # REQUIRED; must match the nfe functions' FUNCTIONS_REGION
# NFE_TASKS_DISABLED=1               # deliberate sweep-only / local dev (no enqueue)

ALLOWED_ADMIN_ORIGINS=https://app.example.com  # CSV; localhost allowed by default
TZ=America/Sao_Paulo                 # log hygiene only — fiscal dates use explicit per-UF offsets (tz.ts, #395)
```

See the master plan's "Cert lifecycle (operations)" section at
`C:\Users\Lucas\.claude\plans\velvet-purring-bear.md` for the
cert / chain rotation playbook.

## Structure

```
app/
  layout.tsx                       Minimal HTML shell
  page.tsx                         Placeholder landing
  api/
    health/route.ts                GET — uptime + ambiente (cert null w/o env cert)
    nfe/
      emitir/route.ts              POST — generate + sign + persist + send (async → hand off)
      emitir-lote/route.ts         POST — batch emit (async chunks hand off)
      consultar/route.ts           GET  — consSitNFe by chave
      cancelar/route.ts            POST — cancelamento evento (tpEvento 110111)
      inutilizar/route.ts          POST — burn an unused número range (sync, cStat 102)
      carta-correcao/route.ts      POST — CC-e evento (tpEvento 110110); 136 → async re-check
      carta-correcao/danfe/route.ts GET — CC-e PDF from the persisted procNFe + record
      danfe/route.ts               GET  — DANFE simplificado / retrato / paisagem / zpl2
      consulta-cadastro/route.ts   POST — SEFAZ Consulta Cadastro (advisory, degrades to 200)
      status-servico/route.ts      GET  — SEFAZ availability (?target=normal|svc)
      processar-pendentes/route.ts POST — manual/ops run of the backstop poller
      verificar/route.ts           POST — re-verify enviNfe audit msgs against SEFAZ
      certificado/route.ts         POST/DELETE — per-filial A1 upload/remove
lib/
  firebase/admin.ts                Admin SDK singletons (same as apps/integrations)
  nfe/
    runtime.ts                     Process-level cert-OPTIONAL base (endpoints + chain cache + lazy envRuntime)
    tasks.ts                       Task-queue producer: RECONCILE_FUNCTION + payload schemas + enqueue seam
    handlers/                      runReconcile / runReconcileCce / runProcessarPendentes —
                                   transport-free cores shared by the routes AND functions/
    orchestrator/reconcile.ts      reconcileByRecibo — under runReconcile + the backstop sweep
    filial-cert.ts                 resolveFilialRuntime / resolveFilialRuntimeByCnpj (per-filial signing)
    orchestrator/                  Pedido → emit/consultar/cancelar/inutilizar/CC-e/DANFE/EPEC,
                                   split per-service behind an index.ts barrel
    auth.ts                        Bearer-token + permission guard
functions/                         NESTED Cloud Functions codebase `nfe` — NOT a pnpm
                                   workspace member; apps/nfe's tsconfig/eslint/vitest
                                   cover it. See functions/DEPLOY.md.
  src/reconciliar.ts               reconciliarNfe (onTaskDispatched) — the queue consumer
  src/sweep.ts                     nfeReconcileSweep (onSchedule) — the backstop
proxy.ts                           CORS for /api/nfe/* (browser callers): GET/POST/DELETE,
                                   exposes Content-Disposition. A non-safelisted verb a route
                                   exports (not GET/HEAD/POST) must be in Allow-Methods —
                                   config-eslint `cors-proxy-covers-routes`
```

## Dev

```bash
cd ../.. && cat .env.example .env.secrets.example > .env.local && cd apps/nfe   # ONE root template set (#730) — NF-e section
pnpm dev                           # all apps from the repo root
curl http://localhost:3004/api/health
```

Port: **3004** (3000 = web, 3001 = integrations, 3002 = legal). The
homologação chain at `packages/integrations/nfe/ca/sefaz-sp-homologacao.pem`
must exist — `pnpm --filter @delfrance/integrations-nfe fetch:sefaz-ca`
captures it on first setup. Exercising **contingência** needs its transport's
own chain as well (rule 4 above) — `--uf=SVC-AN`, `--uf=SVC-RS`, and
`--uf=AN` for EPEC.

## Async reconcile: task queue (primary) + scheduled sweep (backstop)

Both halves live in the **nested `apps/nfe/functions/` codebase** and execute
**in-process** — there is no HTTP hop back into this app, no OIDC, and no
Terraform. `infra/terraform` does not exist in this repo.

**Primary.** On an async lote (`cStat=103` + `nRec`) the emitter hands off and
enqueues a task at `now + tMed` onto the **`reconciliarNfe` Firebase Functions
task queue** — `onTaskDispatched` auto-provisions the queue on deploy, named
after the function. `reconciliarNfe` consults by recibo and re-enqueues with
backoff until terminal. **One decision per round** (`decidirRodadaDoRecibo`,
`orchestrator/lote-sem-protocolo.ts`, #513/#1654): our `protNFe` (strict
chave equality) is applied when final; a 539 is recovered; a processed lote
(104) without it, a per-NF-e verdict at LOTE level (never a final estado
without a protocol), a 106, or a duplicidade 204/205/218/635 is resolved **by
chave** — ONE `consSitNFe` per round (none on a 106's first round: the receipt
may not be indexed yet), read through one recovery table
(`classificarConsSitDeRecuperacao`): a 217 frees the número only when the
protocol was merely missing or the receipt not found — for a duplicidade it is
terminal (539 is facultative, the número may be held under another chave), for
635 it means "still queued" — and a denegada is applied only for a missing
protocol; 103/105/107/108/109/113/114 (or a cStat that is not TStat-shaped) say
nothing and wait; a lote-level 656 or a refused receipt query is terminal
(656 = consumo indevido is never retried — re-querying it risks a SEFAZ ban).
**Every round that leaves a doc in flight advances its `retries` by exactly
one** — an `enviando` doc is written `aguardandoResposta`, a recovered 539
continues its own count — so a doc gets at most `MAX_RECONCILE_ATTEMPTS`
receipt rounds and consSit calls between two operator actions; the manual
verify, a new emit lote and the sweep's consult-by-chave branch for docs
without an `nRec` still reset it. **Every terminal the decision makes carries a
blocking cStat** (`terminalBloqueante`; the 539 recovery keeps its #243
terminals, cStat 539 included): the round's own 103/104/105, else 103 — SEFAZ issued
this receipt — with the real cStat as an xMotivo prefix, so the pedido cannot
be re-emitted over a número SEFAZ may hold; "Verificar novamente"
(`consultarChavePersistida`) then consults by chave through the same decision
and table, without counting (a receipt that says nothing puts the doc back in
flight on it, paced; a stored `rejeitada` is left as it is by that, a 656 or a
refused receipt query — but not by a 103/105, whose lote holding the chave is
still pending at SEFAZ), and `verificarEnviNfeMsgs` stops a run on its
`consumoIndevido` flag, since the persisted cStat no longer shows the 656. A
receipt answering serviço paralisado (108/109/113/114) is paced
`RECONCILE_INDISPONIVEL_DELAY_MS` (one hour, `esperaMinimaDoRecibo`) — the
task's re-enqueue and the doc's `proximaConsultaEm` alike, so the sweep stays
behind the task — and the cap then rides out about ten hours of outage before
the docs need a manual verify. **Every** write of `reconcileByRecibo` is
guarded in its transaction on the receipt, the `retries` it was decided from
and an in-flight estado (`PersistGuard`), so a concurrent terminal or counted
write wins and the doc is tallied by its live estado; a recovered 539's chave
swap rides that same write (`extrasDaTrocaDeChave` — `recover539.ts` writes
nothing to the nfev4 doc — only its `consReciNFe` audit entry — #1654), so a refused write swaps nothing either, in the manual verify
too. One failing doc no longer aborts the round — only for three named causes
(rule 6): a doc deleted mid-round (`NFeDocAusenteError`, the guarded persist's
missing-doc throw) is skipped; a transient Firestore failure
(`isTransientGrpcError`, gRPC 4/8/10/13/14, `@delfrance/data/admin/grpcErrors`)
leaves the doc pending, uncounted unless its by-chave round had already written
the count before its consSit — so a doc whose Firestore failure persists
re-enqueues with no cap, one `consReciNFe` per round; a failed SOAP call of the
539 recovery counts the round, on THIS receipt (the 539's `[nRec:]` marker
names the other chave's lote and never re-keys the doc). Anything else is
rethrown. A breaker stops further consSit
calls after a 656 or an unavailable service — per lote on the task path; across
the sweep's lotes, a 656 per filial and an outage per filial + authorizer (home
/ SVC-AN / SVC-RS, `autorizadorDe`). The doc ends terminal or stays counted.
The breaker lives in a cell the CALLER owns (`DisjuntorConsSit`), written in
place the moment a consSit answer trips it — before any further await — so a
lote whose reconcile throws after a trip still hands it to the sweep's next
lote. ⚠️ On the task path a throw still reaches the queue retry without it
(the cell dies with the run); since the named causes no longer throw, that is
left to anything else thrown after a trip — a bug, a non-transient Firestore
error (gRPC 3/7/9) — (follow-up: a durable per-filial suspension). The
CC-e linkage re-check (`kind: 'cce-vinculo'`, cStat 136) rides the **same**
queue, discriminated by `kind`.

Transport is `firebase-admin`'s `getFunctions().taskQueue(...).enqueue(...)`
(`lib/nfe/tasks.ts`) — no queue path, no runner SA, no `google-auth-library`.
The only knobs are `NFE_TASKS_REGION` and `NFE_TASKS_DISABLED`.

⚠️ **`RECONCILE_FUNCTION` (`lib/nfe/tasks.ts`) must stay equal to the export
name in `functions/src/reconciliar.ts`** — the constant builds the enqueue path
and the export name *is* the deployed function + queue name. Rename both
together or the producer enqueues onto a queue that doesn't exist and the task
silently drops. Pinned twice: a load-time assert in `functions/src/index.ts`
(fires during Firebase's deploy codebase-analysis) and the coupling test in
`functions/src/reconciliar.test.ts`.

**Backstop.** `nfeReconcileSweep` (`functions/src/sweep.ts`, `onSchedule`
`0,30 8-19 * * 1-5` America/Sao_Paulo) catches lost tasks, enqueue failures and
pre-existing stuck docs, and transmits approved EPECs once the filial leaves
contingency. It covers both `nfev4` lotes and `cartacorrecao` records, and is
gated per-doc by `proximaConsultaEm`, so it never consults ahead of a task's
schedule. An `nfev4` doc with no `proximaConsultaEm` (the persist-before-send
anchor, #512's `enviando` dispositions, imported legacy docs) waits
`DEFAULT_STUCK_TIMEOUT_MS` from its last write instead, which keeps the sweep
off a send still in flight (#1653); a `cartacorrecao` record with none is due at
once. No `gcloud scheduler` job to wire — it deploys with the codebase. Its four
per-item catches follow rule 6 through ONE table (`orchestrator/falhas.ts`,
`descreverFalhaConhecida`, #1654): a failure of a known class — the NF-e and
orchestrator classes, `ZodError`, the Cloud Tasks enqueue's
`FirebaseFunctionsError` / `FirebaseAppError` / `NFeTasksEnqueueError` /
`MissingRegionError`, a Firestore gRPC error (`'FirestoreRpcError'`) — is recorded in `errors` with its
message and the run goes on; an unknown class is a bug and is rethrown, so the run aborts loudly
(the scheduled function fails and the next tick retries; the manual route
answers 500) and the lotes after it wait for that retry. A new exported error
class fails `falhas.test.ts` until it is placed in the table or listed as never
reaching a reporting catch. ⚠️ That backstop scans exported CLASSES only, so a
plain Node `Error` escaping a known operation is invisible to it. A filial's
stored key that no longer decrypts (a rotated `NFE_CERT_ENC_KEY`, a tampered
blob) is exactly that case: it is recorded only because `resolveFilialCert`
raises it as the `NFeCertError` it documents — as Node's plain `Error` it would
abort every run, for every filial.

**Lote reply without a receipt (#512).** An async `retEnviNFe` WITHOUT `infRec`
carries no `nRec`, so there is nothing to consult by recibo: `processChunk`
persists one disposition per member at emit time (`patchForLoteSemRecibo`,
written by `persistLoteSemRecibo` through `persistPatchUnlessFinal` guarded by
the chunk's `idLote`, so a doc a newer lote re-stamped or one that went final is
left alone and reported `reused` with its live state, never as this run's
outcome), enqueues **no** task and makes no SEFAZ call beyond the lote
itself. The disposition comes from the LOTE cStat alone — a `protNFe` in that
reply and an xMotivo `[nRec:…]` marker are both ignored. A **fresh** member's
refusal is conclusive, because its bytes were never sent before and the número
is free: 656 → `error`; 108/109/113/114 and every rejection (4-digit cStats
included) → `rejeitada`, keeping SEFAZ's cStat/xMotivo; the sweep never scans
either. A **#396 crash-window** member (retransmitted with its STORED bytes)
stays an anchor on ANY refusal — `aguardandoResposta`, cStat recorded, no
`nRec` — since an earlier send of those exact bytes may already be authorized
and a `rejeitada`/`error` doc would regenerate over them; on 656 its
`proximaConsultaEm` is pushed out 1 h (`CONSUMO_INDEVIDO_ESPERA_MS`, the
consumo-indevido window), otherwise the default pacing applies. 103/105/106 →
`aguardandoResposta`, paced as usual. A per-NF-e verdict (100/150, 101/151, 102,
110/301/302) or an anomaly (104, 107, duplicidade, or a cStat that is not the
XSD's 3–4 digits, such as an empty `<cStat/>`) at LOTE level says nothing about
any member: the doc stays `enviando` with the cStat recorded — never `aprovada`
without a proc, never a número-reusing `rejeitada`. These `enviando`
dispositions carry no `proximaConsultaEm`, so the sweep's due-fallback
(`isStuckEnviando`) picks them up once their `ultima_modificacao` is
`DEFAULT_STUCK_TIMEOUT_MS` (5 min) old, at the next sweep tick after that
(#1653). ⚠️ A member whose lote cStat was 103/104/105 carries a
`STATUS_BLOQUEADORES` cStat, so both emit paths stop at `isBloqueada` before the
#396 crash-window branch: an operator re-emit is a no-op (reported `reused`,
"Em processamento") and only the sweep recovers it. Every in-flight disposition
is recovered by the sweep's `consSitNFe(chave)`, once per doc when due; never
inline, which for a 20-member lote would be the #77 fan-out.

**The sync path shares it (#1654 §1).** `applyAutorizadoOutcome` (the single
emit, and a chunk that shrank to one member) applies only OUR `protNFe` — strict
chave equality; a protNFe for another chave is ignored with a warning — and a
sync reply with no protocol for the chave and no `infRec` takes the SAME
disposition through the same lote-guarded write (`persistirDisposicaoSemRecibo`),
the stored-bytes nuance decided by `origem` (`runAllocateGenerateSignTx`'s
`storedBytes`, `processChunk`'s `storedPaths`). So a FRESH NF-e refused with
108/109/113/114 is `rejeitada` and `POST /emitir` answers 422, as the batch path
has since #512, a lote-level 100/101/102 without a protocol leaves it `enviando`,
and a 106 is no longer consulted inline. The one exception is a lote-level
duplicidade (204/205/218/539/635): one member means no fan-out and no reply
smeared over N, so it keeps its inline recovery — 539 and an `[nRec:]` marker as
before, otherwise ONE `consSitNFe` read through the reconcile's recovery table
(`classificarConsSitDeRecuperacao` keyed by `motivoPorChave`): a final answer is
applied; "still queued" (635 + 217) or an unavailable service leaves a #396
anchor (`aguardandoResposta`, no `nRec`, no proc, nothing enqueued); anything
else — a protNFe for another chave included — is a blocking terminal
(`terminalBloqueante`: 104 inside a 104 reply, else 103). OUR protNFe carrying
a duplicidade (204/205/218/635) or a 106 reads its consSit through the same
table — our 204 inside a 104 + consSit 217 is a blocking `error` 104, never
`rejeitada`. Those three are written under the same lote guard. The pós-EPEC transmission
(`origem 'pos-epec'`) keeps its old handling byte for byte (follow-up). ⚠️ The
anchors this leaves are recovered by the sweep's consult-by-chave branch for
docs without an `nRec`, which is still uncounted, unguarded and blind to the
recovery table — a 204/635 anchor whose consSit later answers 217 turns
`rejeitada` there (follow-up).

**A batch member's failure is reported only for a known class (#1654 §3).**
`emitirPedidosLote` files a member's failure as an `EmitError` through
`toEmitError`, which reads the sweep's table (`descreverFalhaConhecida`,
`orchestrator/falhas.ts`): a known class is reported by its literal code — the
`name` it always had, except that an enqueue failure is now
`'FirebaseFunctionsError'` (an HTTP error reply), `'FirebaseAppError'` (the
network, a timeout, the access token) or `'NFeTasksEnqueueError'` (the
service-account lookup the SDK leaves unwrapped: under Application Default
Credentials each instance's first enqueue asks the metadata server, and
`tasks.ts` converts that gaxios failure), and an Admin-SDK Firestore failure
`'FirestoreRpcError'`, all of which used to read `'Error'`. Those enqueue
failures — `MissingRegionError` included — stay a per-member report, since the
enqueue runs after the send, on members already in flight on their `nRec`; so
does `NFeConsumoIndevidoError`. Any other class is a bug and is rethrown
(rule 6): the batch rejects, `POST /emitir-lote` answers 500,
and every other member's report in that request is lost with it. What that
leaves behind: at prep, ONE bug aborts all ≤50 pedidos with nothing written or
sent; at 4b (generate/sign) the chunk's healthy fresh members are already
unsent #396 anchors, which a re-emit retransmits with their stored bytes (or
the sweep's consSit recovers); after the send each member's reply is audited
before its write, so a member whose write threw is still its anchor — the
state stays consistent, only the report is lost. ⚠️ So `apps/web` no longer
auto-retries `emitir`/`emitirLote` on a 5xx or a network error — only on this
app's own pre-send 503, recognised by its body `error: 'NF-e runtime not
ready'` (`isRuntimeNotReadyBeforeSend`, `apps/web/lib/nfe/withNFeRetry.ts`),
never by `NFeRuntimeNotReadyError` alone: the client maps every 503 to that
class, Cloud Run's own mid-request one included. An emit re-POST is a no-op
only for a bloqueada or `nRec`-in-flight pedido, and
`runChunkAllocateTx` / `runAllocateGenerateSignTx` REGENERATE and RE-SEND every
`rejeitada`/`error` one, so a retried lote re-sent whatever the lost attempt had
just seen refused. A transient 5xx on emit now reaches the operator, who
re-clicks — the lote dialog calls the outcome of any failure but a 400/401/403
or that 503 unknown, and points at the NF column first. ⚠️ **Deploy apps/web no later than apps/nfe**: an older web re-POSTs
the new 500 up to three times, each re-POST re-sending the members the previous
attempt left `rejeitada`/`error`.

`POST /api/nfe/processar-pendentes` still exists, but only as a **manual/ops
trigger** for that same core (`lib/nfe/handlers/runProcessarPendentes.ts`),
behind a normal Firebase user token + `PERM.fiscal.write`.

ℹ️ `NFeTasksConfigError` survives in `lib/nfe/tasks.ts` and the two emit routes
still map it to 503, but `createTaskScheduler()` no longer throws it — the
Firebase-managed queue has no required env to validate. It is a retained type,
not a live failure mode.

## Deploy

**Two deployables.** The app itself is Firebase App Hosting — site name
`nfe-<your-org>`, config `apphosting.yaml` here. Secrets via Firebase console
(Cloud Secret Manager); `NFE_CERT_BASE64` / `NFE_CERT_PASSWORD` are sensitive.

The reconciler functions ship **separately**, from the nested codebase:

```bash
firebase deploy --only functions:nfe --config firebase.nfe.deploy.json --project <project-id>
```

Its secrets (`NFE_CERT_ENC_KEY`, `NFE_CERT_BASE64`, `NFE_CERT_PASSWORD`) are
declared in `functions/src/options.ts` and set with
`firebase functions:secrets:set`; non-secret config goes in
`apps/nfe/functions/.env`. Full lane in `functions/DEPLOY.md`. Deploying is a
manual, coordinated human step — agents never run `firebase deploy`.
