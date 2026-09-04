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
- `app/api/whatsapp/verificacao/solicitar` — `PERM.integracao.write`. **POST**
  `{ integracaoId, metodo: 'SMS' | 'VOICE' }` → requests a 6-digit verification
  code for the number (`request_code`). `{ ok: true }`.
- `app/api/whatsapp/verificacao/confirmar` — `PERM.integracao.write`. **POST**
  `{ integracaoId, codigo }` → verifies the code (`verify_code`); on success flags
  the account `verificado: true` (Admin SDK merge). `{ ok: true, verificado: true }`.
- `app/api/whatsapp/registro` — `PERM.integracao.write`. **POST** `{ integracaoId,
  pin? }` registers the number (`register`); an explicit 6-digit `pin` wins,
  otherwise the stored pin is reused (re-register). The pin is persisted into the
  admin-only `credenciaisWhatsapp` doc and **never echoed/logged/in a URL**.
  **DELETE** `?integracaoId=` deregisters (`deregister`), keeping the stored pin.
  `{ ok: true }`.
- `app/api/whatsapp/health` — `PERM.integracao.read`. **GET** `?integracaoId=` →
  the account-health aggregation (`lib/whatsapp/health.ts`) behind the "Saúde da
  conta" card. See the "PIN registration + account health" section below.
- `app/api/whatsapp/template-message` — `PERM.chat.write` (bit 49). **POST**
  `{ conversaId }` sends the standard "reabertura de conversa" template
  (`reabertura_conversa`) to a WhatsApp conversa and records it as an outbound
  `mensagem`. See the "Template message (mensagem padrão)" section below.
- `app/api/webhooks/whatsapp` — the inbound webhook receiver (#527). **GET** is
  Meta's verify handshake (`hub.mode`/`hub.verify_token`/`hub.challenge`); **POST**
  verifies the `X-Hub-Signature-256` HMAC over the raw body, then enqueues one lean
  payload per `entry[].changes[]` onto the `processWhatsappNotification` task queue
  and acks `200` fast. Server→server (no Bearer, OUT of the `proxy.ts` CORS matcher).
- `lib/whatsapp/{notificacao,processMessages,processStatus,waTasks}.ts` — the queue
  pipeline (see the "Inbound webhook + pipeline" section below).
- `lib/whatsapp/outbound.ts` — the **outbound** send disposition (#529, pure +
  trigger-agnostic): `dispatchOutbound` sends an operator/auto-reply `mensagem`
  via the Cloud API and re-anchors it to the wamid; `sweepStaleOutbound` is the
  stuck-`salva` backstop core. See the "Outbound sender + trigger" section below.
- `lib/signatures/hmac.ts` — `verifyMetaSignature(rawBody, header)` + `verifyHmac`.
- `lib/whatsapp/whatsapp.ts` — `loadWhatsappContext(db, integracaoId)`: validates the
  `integracao` doc exists and `tipo === INTEGRACAO_TIPO.whatsapp`, exposes `conta`,
  `hasToken()` / `resolveToken()`, `buildClient()` (a `WhatsAppClient` for the #529
  sender), plus `fetchWhatsappPhoneNumber()` (the injectable-fetch Graph probe) and
  the app-local error classes.
- `lib/whatsapp/credentialStore.ts` — the single-token store over the admin-only
  `integracao/{id}/credenciaisWhatsapp` subcollection (fixed `current` doc; strays
  deleted on save; `revoke()` clears it). Mirrors apps/mercado-pago's `credentialStore`.
  `save()` **carries a previously-stored `pin` forward** when the incoming cred
  has none (`pin == null`) — so a bare token replacement (the `token` POST route)
  never wipes the two-step registration PIN; an explicit pin (the `registro`
  route) always wins.
- `lib/whatsapp/health.ts` — the account-health aggregator (`buildWhatsappHealth`):
  a single phone-node probe (`getPhoneNumberStatus` → token / phone_status /
  quality / code_verification) plus webhook, inbound, and failed-notification
  checks, folded into check rows + `canSend` / `canReceive` verdicts. Every probe
  failure is a check row, never a route throw.
- `lib/whatsapp/respond.ts` — the error → HTTP mapper (`TokenMissing` /
  `TokenInvalid` → 409 reauth; `ContaNotConfigured` → 404; app-local `Graph` → 502).
  It also maps the client's `WhatsAppHttpError` / `WhatsAppNetworkError` (from the
  PIN/verify/register/status calls): upstream 401 or Graph code 190 → 409
  `WA_REAUTH_REQUIRED`; code 133016 (register cap) → 429 `WA_RATE_LIMIT`; upstream
  400 → 400 with `error_user_msg ?? message`; other HTTP → 502 `WA_GRAPH_ERROR`;
  network → 502.
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
4. **The permanent token AND the two-step PIN never reach the browser.** Both live
   only in the admin-only `integracao/{id}/credenciaisWhatsapp` subcollection
   (default-deny; only the Admin SDK reaches it) — the PIN as `credenciaisWhatsapp.pin`,
   NEVER on the client-readable `integracao` doc (legacy stored it there in
   plaintext; we do not — the old `integracao.pin` field is gone). Do **not** log
   either secret, echo it in a response, or put it in a URL/query string — the POST
   body is the only place they appear, and only inbound. The `register` client
   call keeps the pin out of any error (its `WhatsAppHttpError` carries the
   RESPONSE body only). Never copy the hardcoded legacy `access_token`/`phone_id`
   from `.old/lib/whatsapp/providers/provider.dart`.
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
2. **`lib/whatsapp/notificacao.ts`** — this channel's adapter over the SHARED pipeline
   in `@delfrance/data/admin/notifications` (`defineNotificationPipeline`; see the
   `webhook-notifications` skill): `parseWebhookBody`, the field dispatch, and thin
   `handleNotificationTask` / `persistNotificationFailure` / `reprocessNotifications`
   wrappers. The disposition matrix and the sweep are NOT implemented here.
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
   **#1137**: it also REPORTS what the change did on the outcome's `detail` — a written
   mensagem, an idempotent redelivery, a spam skip, an outbound echo, a statuses-only
   change, or `vazio` (neither `messages` nor `statuses`, i.e. nothing happened). That
   value comes from `createOrUpdateMensagem`'s boolean, which used to be discarded at
   its only call site; it is REPORTED only and must never gate the `ultima_modificacao`
   bump (see the comment at that bump). ⚠️ `detail` names what happened to the
   MENSAGEM, not whether anything was written at all — `upsertConversa` runs BEFORE the
   echo/spam returns, so every value except `statuses`/`vazio` implies the conversa was
   touched.
   **The statuses half of that is separately reported.** `processStatuses` returns a
   `StatusesReport` — `{ aplicados, naoEncontrados, staleIgnorados, malformados,
   desconhecidos }` — carried out to the task log beside `detail`. The first FOUR are
   fates and sum to `statuses.length`; `desconhecidos` is an **overlay** on whichever
   fate the entry met (see the wire-tolerance section below). Counts rather than more `detail` members, because one
   `statuses[]` can carry entries with DIFFERENT fates, which no single enum value can
   express; and because they ride out whichever arm of the priority chain won, an
   `echo` no longer hides applied statuses and a `statuses` that landed nothing no
   longer overstates. The two skip reasons stay APART: a stale skip is working as
   designed and structurally common (the queue dispatches 3 concurrently, so statuses
   race), while a soft miss may be a real doc-id derivation bug — merging them buries
   the interesting one under a permanent noise floor. ⚠️ The SWEEP recomputes the report
   and discards it: `ReprocessResult.outcomes` is a `Record<string, number>` keyed by
   the constant disposition label, with no room for a nested object.
   **One residual remains, deliberately**: `redelivery` names the mensagem skip while
   the same run may have reopened the conversa and bumped `ultima_modificacao`. It stays
   unreported under the rule the statuses report is an instance of — *report in the log
   what leaves no other trace*. A soft-missed status writes nothing but a `console.warn`;
   the conversa story writes its own documents (`evento_nova`, `evento_reaberto_<wamid>`)
   and is derivable from `detail` besides.
4. **`lib/whatsapp/processStatus.ts`** — advances an OUTBOUND mensagem's
   `estadoEnvio` from a `statuses[]` entry, guarded by the exact legacy forward-only
   transition matrix + the `lastExternalUpdateDateTime` out-of-order guard, and
   appends `errors[]`.
5. **`lib/whatsapp/waTasks.ts`** — the enqueue seam (`WHATSAPP_TASKS_DISABLED` valve
   → persist-for-the-sweep; `WHATSAPP_TASKS_REGION` → region-qualified queue path).

### Wire tolerance: one bad element must never cost the delivery

⚠️ **The receiver validates only the ENVELOPE.** `webhookEnvelopeSchema` keeps
`changes[].value` as `z.unknown()`; the full `valuePayloadSchema` runs one layer
down, in `processMessagesField`. Do **not** "tighten" it back. A Zod array fails as
a **whole** when any element fails, so with the value schema mounted at the
receiver a single unrecognised `statuses[].status`, a new `messages[].type`, or
**any** non-`messages` event made `parseWebhookBody` return null — and the route
acked `200` with **no task, no failure document and no log line**. Meta saw a 200
and never retried, so the entire POST (every entry, every change, any customer
message riding along) was lost with no replayable record. `parseWebhookBody` reads
only `object`, `entry[].id`, `changes[].field` and three optional strings, so the
strictness bought nothing. Legacy agreed: `WebhookChangeGeneric.value` is `dynamic`
and only the `messages` change binds a metadata-bearing value type.

That also un-killed `DropOutcome.'campo-nao-suportado'`: WhatsApp **Business
Management** events (`account_update`, `phone_number_quality_update`,
`message_template_status_update`) carry **no `messaging_product` and no
`metadata`**, so the old envelope rejected them and the dispatcher never saw the
field. They now enqueue — one Cloud Task each, low and non-scaling volume — and are
dropped **with a log** in `processChangePayload`.

Three rules follow, all load-bearing:

1. **`statuses[].status` and `messages[].type` are plain strings on the wire**
   (legacy typed both `String`). `status` is narrowed at the point of use by
   `narrowWaStatus`, which keeps the literal union at both `processStatus` switches
   so `switch-exhaustiveness-check` still covers them. The fold is **exact** — no
   trim, no case-fold: `'Sent'` is `desconhecido`, never `'sent'`, because writing a
   confident wrong `estadoEnvio` is worse than the honest one. `type` is read by
   **nothing** (the mensagem tipo comes from which media key is present).
2. **`messages[]` and `statuses[]` are element-tolerant** — `.nullable().catch(null)`
   — and the nulls are **KEPT, not filtered**, so the consumers can count them.
3. **Tolerance is never silent.** Every coerced or dropped element lands in
   `StatusesReport.{malformados,desconhecidos}` or `MensagensReport.malformados`,
   both of which ride out to the single `logger.info` in `processNotification.ts`
   (`?? null` — Cloud Logging drops `undefined` keys). A `.filter()`, or a counter
   that stops incrementing, converts visible data loss into invisible data loss.

### Locating an outbound mensagem for a status callback (PR-3 contract)

`processStatus` reads the DETERMINISTIC doc directly rather than a collection-group
`mid` query: `conversaId = conversaDocId(contaId, senderId(displayPhone,
status.recipient_id))`, `msgId = mensagemDocId(contaId, status.id)`. So the
**outbound sender stores each sent message at
`chat/{conversaId}/mensagem/{mensagemDocId(contaId, sendWamid)}` with
`mid = sendWamid`** (re-anchoring the doc id to the wamid the Graph API returns) —
this is exactly what `dispatchOutbound` does on a successful send (#529, live). A
status whose message isn't found is logged + skipped (a soft miss, never a throw).

### Auto-reply outbound contract (#529 sender trigger)

Legacy SENT the daily auto-reply inline via the Graph API. This pipeline instead
WRITES it as an OUTBOUND `mensagem` doc and lets the `sendOutbound` `onCreate`
trigger send it. **The trigger sends any freshly-created message where**

```
estadoEnvio === ESTADO_ENVIO.salva (1)  AND  tipo not in {'e','!'}  AND  mid == null
  AND  parent conversa origem === 'whatsapp'
```

(an operator's manual reply qualifies identically). Auto-replies are written as
`{ estadoEnvio: salva, tipo: 'c', mid: null }`. The lifecycle EVENTS this pipeline
writes (`nova conversa`, `reaberto`) are also `salva` but carry `tipo: 'e'` (and
error messages `tipo: '!'`), so the `tipo` clause keeps them from being sent;
inbound customer messages are `estadoEnvio: recebido (7)` and never match. The
`origem === 'whatsapp'` clause is the AUTHORITATIVE channel gate: `apps/webchat`
('site' conversas) writes its own NON-null local `mid`, but a 'site' conversa is
excluded by the origem gate regardless of its `mid` convention.

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

## Outbound sender + trigger (#529)

The complement to the inbound pipeline — delivers operator replies + the daily
auto-reply through the Cloud API. Port of `_enviarMensagensWhatsapp` +
`markAnyMessageAsRead` (`.old/lib/chat/providers/conversaProvider.dart`).

1. **`sendOutbound`** (`functions/src/sendOutbound.ts`, `onDocumentCreated` on
   `chat/{conversaId}/mensagem/{mensagemId}`, **named `default` DB**, `retry: true`)
   → the pure `dispatchOutbound` (`lib/whatsapp/outbound.ts`).
2. **Disposition** (`dispatchOutbound`): cheap fast-path exits on the delivered
   snapshot (per the send discriminator above), then loads the conversa, derives
   `to = fromNumberFromSenderId(conversa.sender_id)` and `contaId =
   idFromRef(conversa.integracaoOuterRef)`, builds the account's `WhatsAppClient`
   (via `loadWhatsappContext`), sends **text** (`conteudo`) or **media**
   (`anexoStorage` → the `Arquivo` doc's public `url` as the Cloud API `link`;
   type from the arquivo `filetype`), then TRANSACTIONALLY re-anchors (create the
   `mensagemDocId(contaId, wamid)` doc with the full content + `mid = wamid` +
   `estadoEnvio = enviando` + `lastExternalUpdateDateTime = null`, delete the
   original) so `processStatus` can locate it, and `markRead`s the newest inbound
   (best-effort, non-fatal — one call marks the whole conversa read).
3. **Error vs retry**: missing token / misconfigured conta / unresolvable
   recipient / empty content / a Cloud API HTTP failure (`WhatsAppHttpError` — bad
   request / auth / permanent) → patch the ORIGINAL doc `estadoEnvio = erro (4)` +
   the `error` text (**terminal**, no retry — an operator resends). A **transient**
   failure **throws** so Eventarc (`retry: true`) redelivers: a Cloud API transport
   failure (`WhatsAppNetworkError`), a still-uploading media arquivo (create-first
   `url == null` → `OutboundTransientError`, NOT `erro`), or a transient Firestore
   read/write.
4. **Idempotency + at-least-once**: the `mid != null` fast-path skips the
   re-anchored doc when ITS create re-fires the trigger, and a **transactional
   CLAIM** right before sending flips `estadoEnvio` salva→enviando ONLY while it is
   still (`salva` && `mid == null`). Concurrent dispatchers (a still-retrying
   trigger + the sweep) serialize on it: exactly ONE wins and sends; every loser
   sees a non-`salva`/deleted doc and exits. The ONLY remaining double-**send**
   window is a CRASH between the claim and the re-anchor — the original is left
   `enviando`/`mid == null`, so the sweep re-drives it and that re-driven send can
   rarely duplicate (same at-least-once tail as legacy).
5. **`reprocessStaleOutbound`** (`functions/src/index.ts`, `onSchedule` every 15
   min) → `sweepStaleOutbound`: **two** collection-group queries on `mensagem`
   (`estadoEnvio == salva` and `estadoEnvio == enviando`, both `timestamp <
   now-10min`, snapshotted up front), each re-run through the disposition
   (non-WhatsApp conversas + already-anchored `enviando`/`mid != null` docs drop on
   the fast-path; only `enviando`/`mid == null` crashed claims are re-driven). The
   composite collection-group index `mensagem(estadoEnvio, timestamp)` is declared
   in `firestore.indexes.json` (Enterprise runs it unindexed as a scan otherwise —
   the index is a cost/latency guard).
6. **Client**: `WhatsAppClient.sendMedia({ to, type, link, caption?, replyTo? })`
   (`packages/integrations/whatsapp-cloud-api`) posts the media object by LINK,
   mirroring `sendText`. Caption is omitted for audio (Graph API ignores it there).

## Template message (mensagem padrão) (#PR-C4)

`app/api/whatsapp/template-message` ports legacy `addMensagemPadraoWhatsapp`
(`.old/lib/chat/providers/conversaProvider.dart:1015-1042`): the inbox's "Enviar
mensagem padrão" action. A **template** is the only message shape Meta allows
OUTSIDE the 24h customer-service window, so this is a separate route rather than
a plain outbound text (the composer's `salva`/`mid: null` write would be rejected
by the 24h rule when the window has closed). It gates on `PERM.chat.write` (bit
49); the `mensagem` doc is written server-side with the Admin SDK, so
`PERM.mensagem.write` (bit 52) would ALSO be defensible — `chat.write` is chosen
because the action is a conversa-level operation surfaced from the conversa
header. The client method is `WhatsAppClient.sendTemplate({ to, templateName,
languageCode='pt_BR' })` (`packages/integrations/whatsapp-cloud-api`), mirroring
`sendText`; the wire body carries `recipient_type: 'individual'` + `template: {
name, language: { code } }` (byte-for-byte legacy parity).

**Send-then-write (PRE-ANCHORED).** The template is sent FIRST, THEN the mensagem
is written directly at `mensagemDocId(contaId, wamid)` carrying `mid = wamid` +
`estadoEnvio = enviando` — the SAME re-anchored shape `dispatchOutbound` produces,
written up front. Writing the mensagem FIRST (as a plain `salva`/`mid: null`
text) would race the #529 `sendOutbound` trigger into a SECOND, duplicate send
(the trigger sends any `salva` + `tipo` not in `{e,!}` + `mid == null` +
whatsapp-origem doc). Anchoring to the wamid excludes it from that discriminator,
and lets the #527 status pipeline (`processStatus`, keyed on `mensagemDocId(contaId,
status.id)`) locate the delivery callback. `ALREADY_EXISTS` (gRPC 6) on the
`create` = a redelivery already wrote the doc → treated as ok (idempotent). A
Graph-OK but write-FAIL is logged loudly and returns **502** `WA_TEMPLATE_WRITE_FAILED`
(the template WAS delivered — not the caller's fault). The trailing
converter-stripped conversa bump (`ultima_modificacao`) is best-effort (a failed
ordering bump doesn't fail the request, since the message already landed).

## PIN registration + account health

Ports the legacy PIN/SMS number-registration sub-flow
(`RegistrarPinDialog`/`VerificarCodigoDialog`, `.old/lib/whatsapp/pages/conta.dart`)
plus a new health surface. The six new client methods
(`requestVerificationCode` / `verifyCode` / `register` / `deregister` /
`getPhoneNumberStatus` / `getSubscribedApps`) live in
`packages/integrations/whatsapp-cloud-api` on Graph **v23.0**; this app's routes
stay thin and map errors through `respond.ts`.

**Registration flow (operator, from the panel):**

1. `verificacao/solicitar` → Graph `request_code` sends a 6-digit code (SMS/VOICE).
2. `verificacao/confirmar` → Graph `verify_code`; on success the account is flagged
   `verificado: true` (Admin SDK).
3. `registro` (POST) → Graph `register` with the 6-digit `pin`. Meta requires the
   **SAME pin** to re-register once 2FA is set, so the pin is persisted in
   `credenciaisWhatsapp.pin` and reused when the POST body omits it. `registro`
   (DELETE) → Graph `deregister`, keeping the stored pin.

**Account health (`lib/whatsapp/health.ts`, `GET /api/whatsapp/health`):** a
best-effort aggregation — EVERY probe failure is a check ROW, never a route throw
(only a missing / non-WhatsApp account 404s). Checks: `token`, `phone_status`,
`quality`, `code_verification` (self-heals `verificado` when Graph says VERIFIED
but the doc lags), `webhook_subscription` (needs `integracao.waba_id` — the TRUE
WABA id, distinct from `wa_id`, which is the `phone_number_id`), `webhook_secret`
(env PRESENCE of `WHATSAPP_APP_SECRET` + `WHATSAPP_VERIFY_TOKEN`, never the
values), `inbound_recent` (newest `chat` conversa by `ultimaModificacaoIntegracao`,
now an ms int), `notificacoes_failed` (`count()` of `failed` notifications —
keyed by **`wa_id`**, not `phoneNumberId`: the failure docs carry the webhook's
`metadata.phone_number_id`, which inbound resolution matches against `wa_id`).
Verdicts: `canSend` = token ok && phone_status ok; `canReceive` = webhook_secret
ok && (subscription ok→true / fail→false / skip→null). The
`chat(integracaoOuterRef, ultimaModificacaoIntegracao desc)` composite index is
declared in `firestore.indexes.json` (Enterprise runs it unindexed otherwise —
the index is a cost/latency guard).

## Status

The account/token surface is **live** (`/api/whatsapp/token`, `/api/whatsapp/conta`),
as is the **PIN registration + verification + account-health** surface
(`/api/whatsapp/verificacao/*`, `/api/whatsapp/registro`, `/api/whatsapp/health`).
The inbound **webhook** receiver + pipeline (#527) are now **live** in this app,
including the nested Cloud Functions codebase (`functions/`) that hosts the
`processWhatsappNotification` `onTaskDispatched` consumer + the `reprocessWhatsappNotifications`
`onSchedule` sweep — deploy + the legacy Flutter cutover (`distribuidorWhastappCloudApi` /
`processarNotificacoesWhatsapp`) are documented in `functions/DEPLOY.md`. The
**outbound** sender (#529) is now **live**: the `sendOutbound` `onDocumentCreated`
trigger + the `reprocessStaleOutbound` `onSchedule` backstop (both in `functions/`,
delegating to `lib/whatsapp/outbound.ts`) — see "Outbound sender + trigger" above.
Deploy of the new functions + the `mensagem(estadoEnvio, timestamp)` index is
manual/coordinated — see root `CLAUDE.md`, Critical rules. The **template message** route
(`/api/whatsapp/template-message`, #PR-C4) is now **live** — see the "Template
message (mensagem padrão)" section.

## Env

See the repo-root `.env.example` (WhatsApp Cloud API section; `WHATSAPP_VERIFY_TOKEN`
and `WHATSAPP_APP_SECRET` are in `.env.secrets.example` — one root template set is
the repo convention, #730) + `apphosting.yaml`. The per-account permanent token is NOT an
env var — it is entered per integração and stored server-side. The app-wide
`WHATSAPP_VERIFY_TOKEN` (GET verify handshake) and `WHATSAPP_APP_SECRET` (the
**mandatory** `X-Hub-Signature-256` HMAC secret — unset → the POST returns 503) are
now consumed by the webhook route. `WHATSAPP_TASKS_DISABLED=1` forces the receiver's
persist-for-the-sweep fallback (no enqueue); `WHATSAPP_TASKS_REGION` (default
`FUNCTIONS_REGION`; no default — unset, the enqueue throws) is the region of the `processWhatsappNotification`
function/queue and MUST match its deploy region.

Set `NEXT_PUBLIC_WHATSAPP_URL=http://localhost:3008` so apps/web targets this
backend. Deploy of the App Hosting backend is **manual and coordinated**
— see root `CLAUDE.md`, Critical rules.
