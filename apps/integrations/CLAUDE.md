# apps/integrations — CLAUDE.md

API-only Next.js app. Receives webhooks and OAuth callbacks from external systems. Deploys to Firebase App Hosting.

## Rules specific to this app

1. **No UI code**. No React components beyond the placeholder root page. Add nothing under `app/(app)/` or any client routes.
2. **Route handlers stay thin**. Validate signature, parse payload, optionally write a marker doc to Firestore, then **dispatch heavy work to a Cloud Function** via `lib/queue/dispatch.ts`. Respond fast (200 within ~1s).
3. **No Firebase Auth user sessions here**. Auth is per-channel: HMAC signature, OAuth state token, or Firebase ID token verified via Admin SDK for callable-style endpoints.
4. **All secrets in Cloud Secret Manager** (Firebase App Hosting wires them in). Never commit secrets to apphosting.yaml.
5. **Idempotency is mandatory**. Most marketplaces retry. Use a dedup key (event ID) when calling `dispatch`.

## Structure

```
app/
  layout.tsx              Minimal HTML shell (App Router requires it)
  page.tsx                Placeholder landing
  api/
    health/route.ts       GET — uptime check
    webhooks/
      _test/route.ts      POST with HMAC verification — wiring smoke test
      <channel>/...       Phase 5: ML, Shopee, Amazon, Magalu, Loja Integrada, FB, WhatsApp, MP
    oauth/
      <channel>/callback/route.ts   Phase 5: OAuth code-for-token exchange
lib/
  firebase/admin.ts       Singletons via firebase-admin SDK
  signatures/hmac.ts      Constant-time HMAC verify
  queue/dispatch.ts       Stub now → Pub/Sub or Cloud Function HTTP in Phase 5
```

## Dev

```bash
cp .env.example .env.local
pnpm --filter @delfrance/integrations-app dev   # http://localhost:3001
curl http://localhost:3001/api/health
```

## Deploy

Firebase App Hosting. Site: configured per-deployment (e.g. `api-<your-org>`). Config: `apphosting.yaml` here.
