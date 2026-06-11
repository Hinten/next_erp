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
   recovery section.
2. **No UI code.** Same shape as `apps/integrations`. The placeholder
   `page.tsx` exists only because Next requires a root route.
3. **Auth is Bearer `idToken` from Firebase Auth.** Pattern in
   `lib/nfe/auth.ts:verifyCaller`. Required perm:
   - `PERM.fiscal.read`  → `/api/nfe/consultar`
   - `PERM.fiscal.write` → `/api/nfe/emitir` and `/api/nfe/processar-pendentes`
4. **Cert + chain at boot.** The NF-e runtime
   (`lib/nfe/runtime.ts:getNFeRuntime`) is a process-level singleton.
   Boot fails hard if the A1 cert is missing/expired or the SEFAZ TLS
   chain isn't vendored under
   `packages/integrations/nfe/ca/sefaz-<uf>-<ambiente>.pem`. Run
   `pnpm --filter @delfrance/integrations-nfe fetch:sefaz-ca` to capture
   the chain locally.
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
NFE_CERT_PATH=./.ignore/cert.pfx    # or NFE_CERT_BASE64
NFE_CERT_PASSWORD=...
# NFE_ALLOW_PRODUCAO=true            # only if NFE_AMBIENTE=producao
# NFE_SVC_AUTHORIZER_OVERRIDE=svc-rs # homologação-only: force the SVC lane to
                                     # SVC-RS (SVC-AN has no DNS outside SEFAZ
                                     # activation windows); throws in produção

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
    health/route.ts                GET — uptime + cert subject + notAfter
    nfe/
      emitir/route.ts              POST — generate + sign + persist + send
      consultar/route.ts           GET  — consSitNFe by chave
      processar-pendentes/route.ts POST — anti-loss poller (cron-driven)
lib/
  firebase/admin.ts                Admin SDK singletons (same as apps/integrations)
  nfe/
    runtime.ts                     Process-level cert + agent + endpoints cache
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

## Cloud Scheduler (production / staging deploy step)

`processar-pendentes` is meant to run on a cron. Wire it up at deploy:

```bash
gcloud scheduler jobs create http nfe-processar-pendentes \
  --schedule="every 5 minutes" \
  --uri="https://nfe-<deployment>.web.app/api/nfe/processar-pendentes" \
  --http-method=POST \
  --oidc-service-account-email=<sa>@<project>.iam.gserviceaccount.com \
  --headers="Content-Type=application/json" \
  --message-body='{}'
```

The OIDC token Scheduler sends counts as a Bearer token; verify in
`lib/nfe/auth.ts` against a service account allowlist (or grant
`PERM.fiscal.write` to the SA in Firestore claims).

## Deploy

Firebase App Hosting. Site name: `nfe-<your-org>`. Config:
`apphosting.yaml` here. Secrets via Firebase console (Cloud Secret
Manager) — `NFE_CERT_BASE64` / `NFE_CERT_PASSWORD` are sensitive.
