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
   **Rotating a filial's cert needs an apps/nfe restart** (the decrypted cert
   is process-cached; the upload route evicts its own instance's entry).
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
   bad sub-field (invalid stamp) — no silent fallback. The subcollection
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
proxy.ts                           CORS for /api/nfe/* (browser callers)
```

## Dev

```bash
cd ../.. && cat .env.example .env.secrets.example > .env.local && cd apps/nfe   # ONE root template set (#730) — NF-e section
pnpm dev                           # all apps from the repo root
curl http://localhost:3004/api/health
```

Port: **3004** (3000 = web, 3001 = integrations, 3002 = webchat). The
homologação chain at `packages/integrations/nfe/ca/sefaz-sp-homologacao.pem`
must exist — `pnpm --filter @delfrance/integrations-nfe fetch:sefaz-ca`
captures it on first setup.

## Async reconcile: task queue (primary) + scheduled sweep (backstop)

Both halves live in the **nested `apps/nfe/functions/` codebase** and execute
**in-process** — there is no HTTP hop back into this app, no OIDC, and no
Terraform. `infra/terraform` does not exist in this repo.

**Primary.** On an async lote (`cStat=103` + `nRec`) the emitter hands off and
enqueues a task at `now + tMed` onto the **`reconciliarNfe` Firebase Functions
task queue** — `onTaskDispatched` auto-provisions the queue on deploy, named
after the function. `reconciliarNfe` consults by recibo and re-enqueues with
backoff until terminal (capped at `MAX_RECONCILE_ATTEMPTS`; cStat 656 =
consumo indevido is terminal and never retried — re-querying it risks a SEFAZ
ban). The CC-e linkage re-check (`kind: 'cce-vinculo'`, cStat 136) rides the
**same** queue, discriminated by `kind`.

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
schedule. No `gcloud scheduler` job to wire — it deploys with the codebase.

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
