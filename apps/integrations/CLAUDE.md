# apps/integrations — CLAUDE.md

**Shared webhook/OAuth scaffolding only** — not a home for channel-specific routes.

This app provides the **authentication/verification layers** that every webhook/OAuth flow needs: `withSignature` HOF for HMAC-verified webhooks, `verifyCaller` for Cloud Function admittance. It also hosts the health-check endpoint and the admin user-management callable endpoints that `apps/web` consumes (user creation, custom-claims refresh).

**Every marketplace/channel has its own app** — see root `CLAUDE.md` rule on channel-specific routes. A new receiver does NOT go in `apps/integrations`; it goes in its own `apps/<channel>` backend with its own Cloud Functions codebase and deployment manifest.

## Structure

```
app/
  layout.tsx              Minimal HTML shell (App Router requires it)
  page.tsx                Placeholder landing
  api/
    health/route.ts       GET — uptime check
    admin/
      users/route.ts      POST — admin user creation (requires PERM.su or bearer token)
      users/[uid]/
        claims/route.ts   POST — recompute custom claims for a uid
    webhooks/
      <channel>/...       DEPRECATED — moved to apps/<channel>. Do not add routes here.
    oauth/
      <channel>/...       DEPRECATED — moved to apps/<channel>. Do not add routes here.
lib/
  firebase/admin.ts       Singletons via firebase-admin SDK
  signatures/
    hmac.ts               Constant-time HMAC verify
    withSignature.ts      HOF that wraps a handler: verify HMAC, parse JSON, call handler
  auth/
    verifyCaller.ts       Admin SDK token + auth verification for Cloud Function callables
```

> **Melhor Envio freight lives in its own app** — `apps/melhor-envio` (`:3005`), split out for isolated logs/deploy. Its webhook receiver, OAuth flow, and Cloud Functions codebase all live there.

## Dev

```bash
cd ../.. && cat .env.example .env.secrets.example > .env.local && cd apps/integrations   # ONE root template set (#730)
pnpm dev                                        # run all apps from the repo root
curl http://localhost:3001/api/health
```

Deploys to Firebase App Hosting on :3001. Required by `apps/web` for admin endpoints. Prefer `pnpm dev` at the root. For isolated webhook/OAuth testing (on a channel app), use `pnpm --filter @delfrance/<channel>-app dev` on that app instead.

## Rewrite note (2026-07-24)

Dead scaffolding removed: `lib/queue/dispatch.ts` (stub, never integrated), `app/api/webhooks/_test/` (smoke test replaced by `lib/signatures/withSignature.test.ts`), and stale OAuth/webhook docs. The app now documents what it **is** — shared verifiers — rather than what it was planned to be.
