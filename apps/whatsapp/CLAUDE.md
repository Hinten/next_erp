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
- `app/api/webhooks/whatsapp` — the inbound webhook receiver (#527). **GET** is
  Meta's verify handshake (`hub.mode`/`hub.verify_token`/`hub.challenge`); **POST**
  verifies the `X-Hub-Signature-256` HMAC over the raw body, then enqueues one lean
  payload per `entry[].changes[]` onto the `processWhatsappNotification` task queue
  and acks `200` fast. Server→server (no Bearer, OUT of the `proxy.ts` CORS matcher).
- `lib/whatsapp/{notificacao,processMessages,processStatus,waTasks}.ts` — the queue
  pipeline (see the "Inbound webhook + pipeline" section below).
- `lib/signatures/hmac.ts` — `verifyMetaSignature(rawBody, header)` + `verifyHmac`.
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
- `functions/` — the nested Cloud Functions codebase (deploy-artifact sub-build; see
  `functions/DEPLOY.md`). Covered by this app's typecheck/lint/test tasks. Mirrors
  `apps/mercado-pago/functions`.

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

## Inbound webhook + pipeline (#527)

Mirrors `apps/mercado-pago`'s queue-based receiver structurally; the semantics are
ported from the legacy Flutter handler (`.old/.../whatsapp_cloud_api`). Flow:

1. **Receiver** (`app/api/webhooks/whatsapp/route.ts`) — reads the raw body ONCE,
   verifies Meta's signature over those exact bytes (**secret unset → 503**, never
   skipped; mismatch → 401), parses the envelope into one payload per change, and
   ENQUEUES each onto the `processWhatsappNotification` queue. **No Firestore write
   on the happy path.** Malformed/empty bodies are acked `200`. On an enqueue
   failure it persists the change as `failed` (for the sweep) rather than 5xx.
2. **`lib/whatsapp/notificacao.ts`** — the shared core: `parseWebhookBody`,
   `handleNotificationTask` (the MP disposition matrix: done / transient-throw /
   failed-park / dropped), `persistNotificationFailure`, `reprocessNotifications`.
   Dispatches by `changes[].field`: only `messages` is processed; every other field
   is dropped. **Unlike MP there is no re-fetch anchor** — the message content lives
   only in the webhook body — so a persisted failure doc CARRIES the change `value`
   (an untyped passthrough field on the admin-only, default-deny
   `notificacoesWhatsapp` doc) so the sweep can REPLAY it. The failure doc is keyed
   by the WA `messageId`.
3. **`lib/whatsapp/processMessages.ts`** — resolves the owning account by
   `wa_id == metadata.phone_number_id` (`limit 2`; 0 or >1 → failed park),
   discovers the contact, create-or-reopens the `chat` conversa in a transaction,
   attaches the `mensagem` (downloading + caching media), runs the daily auto-reply,
   then `fixConversaAnonima`. All ids are DETERMINISTIC (conversa/mensagem/event/
   auto-reply) so redeliveries + retries converge instead of forking.
4. **`lib/whatsapp/processStatus.ts`** — advances an OUTBOUND mensagem's
   `estadoEnvio` from a `statuses[]` entry, guarded by the exact legacy forward-only
   transition matrix + the `lastExternalUpdateDateTime` out-of-order guard, and
   appends `errors[]`.
5. **`lib/whatsapp/waTasks.ts`** — the enqueue seam (`WHATSAPP_TASKS_DISABLED` valve
   → persist-for-the-sweep; `WHATSAPP_TASKS_REGION` → region-qualified queue path).

### Locating an outbound mensagem for a status callback (PR-3 contract)

`processStatus` reads the DETERMINISTIC doc directly rather than a collection-group
`mid` query: `conversaId = conversaDocId(contaId, senderId(displayPhone,
status.recipient_id))`, `msgId = mensagemDocId(contaId, status.id)`. So **PR-3's
outbound sender MUST store each sent message at
`chat/{conversaId}/mensagem/{mensagemDocId(contaId, sendWamid)}` with
`mid = sendWamid`** (re-anchoring the doc id to the wamid the Graph API returns). A
status whose message isn't found is logged + skipped (a soft miss, never a throw).

### Auto-reply outbound contract for PR-3 (#529 sender trigger)

Legacy SENT the daily auto-reply inline via the Graph API. This pipeline instead
WRITES it as an OUTBOUND `mensagem` doc and lets PR-3's `onCreate` trigger send it.
**PR-3's trigger sends any freshly-created message where**

```
estadoEnvio === ESTADO_ENVIO.salva (1)  AND  tipo !== 'e' (evento)  AND  mid == null
```

(an operator's manual reply qualifies identically). Auto-replies are written as
`{ estadoEnvio: salva, tipo: 'c', mid: null }`. The lifecycle EVENTS this pipeline
writes (`nova conversa`, `reaberto`) are also `salva` but carry `tipo: 'e'`, so the
`tipo !== 'e'` clause keeps PR-3 from sending them; inbound customer messages are
`estadoEnvio: recebido (7)` and never match.

### The `estaAberto` UTC-hour quirk (models.dart:288-308)

`Horario_Whatsapp.abertura/.fechamento` encode a year-0-anchored LOCAL wall clock
(schema codec). Legacy `Periodo_Whatsapp.compareHoje` converts each to UTC
(`.toUtc().hour/.minute`) before building today's open/close instants and comparing
to now — a quirk that skews the comparison by the operator's timezone offset (an
08:00 typed by a UTC-3 operator compares as ~11:06). On the UTC deploy clock,
`decodeHorarioMs` (server-local read) yields exactly those `.toUtc()` values, so
`estaAberto` decodes ONLY via `decodeHorarioMs` and builds the comparison with
`Date.UTC(...)` — reproducing the legacy decision, quirk included. Never re-derive
the ms by hand.

## Status

The account/token surface is **live** (`/api/whatsapp/token`, `/api/whatsapp/conta`).
The inbound **webhook** receiver + pipeline (#527) are now **live** in this app,
including the nested Cloud Functions codebase (`functions/`) that hosts the
`processWhatsappNotification` `onTaskDispatched` consumer + the `reprocessWhatsappNotifications`
`onSchedule` sweep — deploy + the legacy Flutter cutover (`distribuidorWhastappCloudApi` /
`processarNotificacoesWhatsapp`) are documented in `functions/DEPLOY.md`. The
**outbound** sender (#529) and its `onCreate` trigger (the auto-reply/manual-reply
contract above) follow.

## Env

See `.env.example` + `apphosting.yaml`. The per-account permanent token is NOT an
env var — it is entered per integração and stored server-side. The app-wide
`WHATSAPP_VERIFY_TOKEN` (GET verify handshake) and `WHATSAPP_APP_SECRET` (the
**mandatory** `X-Hub-Signature-256` HMAC secret — unset → the POST returns 503) are
now consumed by the webhook route. `WHATSAPP_TASKS_DISABLED=1` forces the receiver's
persist-for-the-sweep fallback (no enqueue); `WHATSAPP_TASKS_REGION` (default
`FUNCTIONS_REGION` → `us-east5`) is the region of the `processWhatsappNotification`
function/queue and MUST match its deploy region.

Set `NEXT_PUBLIC_WHATSAPP_URL=http://localhost:3008` so apps/web targets this
backend. Deploy of the App Hosting backend is **manual and coordinated**
(CLAUDE.md critical rule #1).
