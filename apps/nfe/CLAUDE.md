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
   (`procPersistExtras` in `lib/nfe/orchestrator/audit.ts`) — the
   `nfeProc` embeds the signed XML, so the anchor is replaced, never
   lost. Never clear `xml_assinado` any other way.
2. **No UI code.** Same shape as `apps/integrations`. The placeholder
   `page.tsx` exists only because Next requires a root route.
3. **Auth is Bearer `idToken` from Firebase Auth.** Pattern in
   `lib/nfe/auth.ts:verifyCaller`. Required perm:
   - `PERM.fiscal.read`  → `/api/nfe/consultar`
   - `PERM.fiscal.write` → `/api/nfe/emitir` and `/api/nfe/processar-pendentes`
   - **`/api/nfe/reconciliar` is NOT a Firebase-user route** — it is the target
     of the `reconciliarNfe` Cloud Tasks function and authenticates a **Google
     OIDC token** from the functions runtime service account via
     `verifyServiceCaller` (audience = `serviceAudience('/api/nfe/reconciliar')`
     from `NFE_BASE_URL`, allow-list = `NFE_TASK_SA_EMAILS`). The token is
     Google-signed, not Firebase's securetoken service, so `verifyCaller`
     (Firebase `verifyIdToken`) would reject it.
   - **`/api/nfe/processar-pendentes` accepts EITHER** a Firebase user with
     `PERM.fiscal.write` **or** the OIDC service account (the `nfeReconcileSweep`
     onSchedule backstop) — dual auth, service caller tried first.
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
5. **Per-item `imposto` must be stamped on every Pedido item.** The
   orchestrator reads `pedido.itens[i].imposto` and validates it via
   the library's `impostoSchema` (`@delfrance/integrations-nfe`
   exports it). Missing or invalid `imposto` is `NFeMissingImpostoError`
   (or `NFeOrchestratorError` for sub-field issues) — no fallback.
   The Flutter resolver chain (item → product → category → operação)
   that auto-stamps this at pedido-authoring time is a Phase D port.
   For now, every pedido item that will become an NF-e arrives with
   `imposto` already populated.
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
8. **`NFE_ALLOW_PRODUCAO=true` is required for produção.** The library's
   safety guard (`assertSafeTpAmb`) rejects `tpAmb='1'` without it. Set
   only in the produção App Hosting backend.
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

# Async reconciler (Firebase Functions: Cloud Tasks + Scheduler).
# Async-lote emits enqueue a task onto the `reconciliarNfe` queue (auto-created by
# the onTaskDispatched function in apps/functions); the onSchedule backstop sweep
# calls /api/nfe/processar-pendentes. Both call back over OIDC, validated here.
NFE_BASE_URL=https://nfe-<deployment>.web.app   # this app's own public base (OIDC audience)
NFE_TASK_SA_EMAILS=<functions-runtime-sa>@<p>.iam.gserviceaccount.com  # OIDC allow-list (CSV)
# NFE_TASKS_REGION=us-east1          # region of the reconciliarNfe function/queue (default us-east1)
# NFE_TASKS_DISABLED=1               # deliberate sweep-only / local dev (no enqueue)

ALLOWED_ADMIN_ORIGINS=https://app.example.com  # CSV; localhost allowed by default
TZ=America/Sao_Paulo                 # SEFAZ wants the issuer's local time
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
      reconciliar/route.ts         POST — Cloud Task target: reconcile a lote by recibo (OIDC)
      processar-pendentes/route.ts POST — backstop sweep (slow cron, Firebase token)
      certificado/route.ts         POST/DELETE — per-filial A1 upload/remove
lib/
  firebase/admin.ts                Admin SDK singletons (same as apps/integrations)
  nfe/
    runtime.ts                     Process-level cert-OPTIONAL base (endpoints + chain cache + lazy envRuntime)
    tasks.ts                       Enqueues reconcile tasks onto the reconciliarNfe Firebase task queue
    orchestrator/reconcile.ts      reconcileByRecibo — shared by /reconciliar + the backstop sweep
    filial-cert.ts                 resolveFilialRuntime / resolveFilialRuntimeByCnpj (per-filial signing)
    orchestrator/                  Pedido → emit/consultar/cancelar/inutilizar,
                                   split per-service behind an index.ts barrel
    tribute.ts                     Homologação tributary stub (Phase A scaffolding)
    auth.ts                        Bearer-token + permission guard
proxy.ts                           CORS for /api/nfe/* (browser callers)
```

## Dev

```bash
cp .env.example .env.local
pnpm dev                           # all apps from the repo root
curl http://localhost:3004/api/health
```

Port: **3004** (3000 = web, 3001 = integrations, 3002 = webchat). The
homologação chain at `packages/integrations/nfe/ca/sefaz-sp-homologacao.pem`
must exist — `pnpm --filter @delfrance/integrations-nfe fetch:sefaz-ca`
captures it on first setup.

## Async reconcile: Cloud Tasks (primary) + sweep (backstop) — via Firebase Functions

Both triggers are **Firebase Functions** (in `apps/functions`), so there is **no
Terraform / manual `gcloud` provisioning** — `firebase deploy` creates the Cloud
Tasks queue and the Cloud Scheduler job. apps/nfe stays THE SEFAZ/cert boundary;
the functions are thin dispatchers that call back here over OIDC.

The **primary** confirmation path is a **Cloud Task**: emit enqueues a task at
`now + tMed` onto the `reconciliarNfe` queue (`firebase-admin`'s
`getFunctions().taskQueue(...).enqueue()` — `lib/nfe/tasks.ts`). The
`onTaskDispatched` `reconciliarNfe` function (auto-provisions the queue on
deploy) forwards it to `/api/nfe/reconciliar`, which consults by recibo and
re-enqueues with backoff until terminal (capped at `MAX_RECONCILE_ATTEMPTS`;
cStat 656 is terminal — never retried).

`processar-pendentes` is the **backstop sweep** — driven by the
`nfeReconcileSweep` `onSchedule` function (every 30 min, 08:00–19:00 Mon–Fri,
America/São_Paulo). It catches lost tasks / enqueue failures / pre-existing stuck
docs, shares the same `reconcileByRecibo` core, and respects each doc's
`proximaConsultaEm`, so it never consults ahead of the task's schedule.

Both functions present a Google OIDC token (their runtime SA, audience =
`serviceAudience(path)` from `NFE_BASE_URL`); verify in `lib/nfe/auth.ts`
(`verifyServiceCaller`) against the `NFE_TASK_SA_EMAILS` allow-list. One-time IAM
(the apps/nfe runtime SA needs `roles/cloudtasks.enqueuer` +
`roles/iam.serviceAccountUser` on the functions runtime SA) is in
`apps/functions/DEPLOY.md`.

## Deploy

Firebase App Hosting. Site name: `nfe-<your-org>`. Config:
`apphosting.yaml` here. Secrets via Firebase console (Cloud Secret
Manager) — `NFE_CERT_BASE64` / `NFE_CERT_PASSWORD` are sensitive.
