# apps/whatsapp

API-only Firebase **App Hosting** backend for the WhatsApp Business Cloud API
channel — one deployable backend per channel (deploy/scale/failure isolation,
mirroring the legacy per-channel Cloud Run services). It **imports** the
WhatsApp client from `packages/integrations/whatsapp-cloud-api` (the library)
and hosts the channel's HTTP routes. Modeled on `apps/mercado-pago` (App Hosting
backend), adapted payments → whatsapp and **dropping the OAuth flow** — the
WhatsApp Cloud API token is a long-lived Meta Graph token, so there is no
consent URL / code exchange / refresh here (no `oauth` routes, no `state.ts`).

## Layout

- `app/api/health` — uptime check (no auth).
- `app/api/whatsapp/token` — `PERM.integracao.write`-gated. **POST** `{ integracaoId,
  token }` stores the operator-supplied permanent token; **DELETE** `?integracaoId=`
  revokes it. The token is written to the admin-only `credenciaisWhatsapp`
  subcollection and is **never logged or echoed back** (response is `{ ok: true }`).
- `app/api/whatsapp/conta` — `PERM.integracao.read`-gated connection status. A live
  Graph phone-number lookup (`display_phone_number` / `verified_name`) when a token
  is stored; `{ connected: false }` when there is no token or Graph rejects it
  (401 / error code 190). The token is never returned.
- `lib/whatsapp/whatsapp.ts` — `loadWhatsappContext(db, integracaoId)`: validates the
  `integracao` doc exists and `tipo === INTEGRACAO_TIPO.whatsapp`, exposes `conta`,
  `hasToken()` / `resolveToken()`, `buildClient()` (a `WhatsAppClient` for the #529
  sender), plus `fetchWhatsappPhoneNumber()` (the injectable-fetch Graph probe) and
  the app-local error classes.
- `lib/whatsapp/credentialStore.ts` — the single-token store over the admin-only
  `integracao/{id}/credenciaisWhatsapp` subcollection (fixed `current` doc; strays
  deleted on save; `revoke()` clears it). Mirrors apps/mercado-pago's `credentialStore`.
- `lib/whatsapp/respond.ts` — the error → HTTP mapper (`TokenMissing` /
  `TokenInvalid` → 409 reauth; `ContaNotConfigured` → 404; `Graph` → 502).
- `lib/{auth,firebase}` — per-app copies of the shared helpers (each backend keeps
  its own so they deploy + log independently).

## Rules specific to this app

1. **No UI code** beyond the placeholder root page. Thin route handlers.
2. **Auth is per-endpoint**: Firebase ID token (`verifyCaller`) for the callable
   `/api/whatsapp/*` routes. No Firebase Auth user sessions.
3. **All Firestore access via `@delfrance/data/admin/collections` handles** —
   raw `.collection()`/`.doc()`/`.collectionGroup()` is lint-banned (except the
   `lib/firebase/admin.ts` singleton).
4. **The permanent token never reaches the browser.** It lives only in the
   admin-only `integracao/{id}/credenciaisWhatsapp` subcollection (default-deny;
   only the Admin SDK reaches it). Do **not** log it, echo it in a response, or
   put it in a URL/query string — the POST body is the only place it appears, and
   only inbound. Never copy the hardcoded legacy `access_token`/`phone_id` from
   `.old/lib/whatsapp/providers/provider.dart`.
5. **CORS** is handled by `proxy.ts` (Next 16 middleware) for `/api/whatsapp/*`
   only.

## The `wa_id` == `phone_number_id` quirk

Legacy `Conta_Whatsapp` carries **both** `wa_id` and `phoneNumberId`, and
populates both with the **same** value: the WhatsApp Cloud API **phone number
id** (Meta Graph), *not* the WhatsApp Business Account id its name implies. The
legacy inbound pipeline resolves an account by matching the webhook payload's
`metadata.phone_number_id` against `wa_id`. Both fields are kept separate for
wire parity. Do **not** "fix" the naming — #527's inbound resolution depends on
matching legacy exactly.

The **sending number** and the Graph lookup resolve it from `conta.phoneNumberId`
**only** — there is **no `wa_id` fallback**. Legacy `getPhoneNumberId()` throws
when `phoneNumberId` is null (it never falls back), and `wa_id`, despite usually
carrying the same value, is semantically a WhatsApp Business Account id (a
different Graph node); sending to it would be wrong. `phoneNumberId()` in
`lib/whatsapp/whatsapp.ts` throws `WhatsappContaNotConfiguredError` when the
número is unset, and the `conta` route degrades that to a 200
`{ connected: false, hasToken: true, reason: 'numero_nao_configurado' }`.

## Status

The account/token surface is **live**: an operator stores/revokes the per-account
permanent token (`/api/whatsapp/token`) and the panel reads live connection
status (`/api/whatsapp/conta`) via a Graph phone-number probe. The inbound
**webhook** receiver (#527) and the **outbound** sender (#529) land in the next
PRs; the nested Cloud Functions codebase (`functions/`) and its
`WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` consumers arrive with the webhook.

## Env

See `.env.example` + `apphosting.yaml`. The per-account permanent token is NOT an
env var — it is entered per integração and stored server-side. The app-wide
`WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` secrets are declared for the
webhook that lands next (#527); no route here reads them yet.

Set `NEXT_PUBLIC_WHATSAPP_URL=http://localhost:3008` so apps/web targets this
backend. Deploy of the App Hosting backend is **manual and coordinated**
(CLAUDE.md critical rule #1).
