# apps/nfe — CLAUDE.md

Authoritative NF-e (Nota Fiscal Eletrônica) API host. API-only Next.js
app. Deploys to Firebase App Hosting. Talks to SEFAZ.

## Rules specific to this app

1. **Persist-before-send is mandatory.** Any new code path that talks
   to SEFAZ must write the NF-e doc to
   `pedidos/{pedidoId}/nfev4/{chave}` with `estado='enviando'`, the
   computed `chave`, and the signed `xml_assinado` **before** the SOAP
   request. This is the anti-loss anchor — see
   `lib/nfe/orchestrator.ts:emitirPedido` and the master plan's A8
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
5. **Tributary stub is homologação-only.** `lib/nfe/tribute.ts`
   produces minimal XSD-valid `<imposto>` / `<total>` / `<transp>` /
   `<pag>` blocks (Simples Nacional CSOSN 102, zero values). Phase D
   replaces them with the real tributary engine.
6. **`NFE_ALLOW_PRODUCAO=true` is required for produção.** The library's
   safety guard (`assertSafeTpAmb`) rejects `tpAmb='1'` without it. Set
   only in the produção App Hosting backend.

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
    orchestrator.ts                Pedido → emit, with persist-before-send
    tribute.ts                     Homologação tributary stub (Phase A scaffolding)
    auth.ts                        Bearer-token + permission guard
middleware.ts                      CORS for /api/nfe/* (browser callers)
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
