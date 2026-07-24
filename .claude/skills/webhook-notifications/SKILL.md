---
name: webhook-notifications
description: >-
  Domain reference for inbound webhook/notification ingestion in this monorepo —
  the standardized enqueue-first pipeline every channel shares
  (`defineNotificationPipeline` in `@delfrance/data/admin/notifications`): the
  receiver that acks 200 without writing Firestore, the `onTaskDispatched` task
  handler, the failures-only `notificacoes*` collection, and the `onSchedule`
  durable-cursor reprocess sweep. Use when implementing, debugging or reviewing
  a channel that RECEIVES asynchronous provider events: webhook, notificação,
  notification, receiver, callback, push, IPN, Cloud Tasks queue, task handler,
  reprocess sweep, backstop, dead-letter, replay, idempotency, dedup, retry,
  redelivery, at-least-once, or adding a new channel's receiver. Triggers on work
  in `apps/{mercado-livre,mercado-pago,whatsapp,melhor-envio}/app/api/webhooks`,
  their `lib/*/notificacao.ts` and nested `functions/`, and on terms like
  defineNotificationPipeline, NotificationDisposition, toDisposition,
  handleNotificationTask, reprocessNotifications, persistNotificationFailure,
  processedAt, tentativas, MAX_TENTATIVAS, TASK_MAX_ATTEMPTS, parked, ALREADY_EXISTS,
  notificationResilienceFields, mlTasks/mpTasks/waTasks, *_TASKS_DISABLED,
  *_TASKS_REGION, onTaskDispatched, onSchedule.
---

# Webhook notification ingestion

Every channel that receives asynchronous provider events (marketplace orders,
payment status, WhatsApp messages, freight status) runs **one shared pipeline**.
A channel supplies only what is genuinely its own — the collection, the payload
shape, and a `process` function — and inherits every resilience behaviour
identically: retry disposition, dead-lettering, the durable-cursor sweep.

**The load-bearing constraint: this is ENQUEUE-first, not persist-first.** A
notification that processes cleanly writes **nothing** to Firestore. Do not
"fix" this back to persisting every event — see *Why not persist-first* below.

## Where it lives (architecture map)

| Layer | Path | Holds |
| --- | --- | --- |
| **Shared core** | `packages/data/src/admin/notifications/` (`@delfrance/data/admin/notifications`) | `defineNotificationPipeline` (the whole disposition matrix + sweep), `createNotificationStore` (the 4 writes), `asMillis`, the constants. Firestore imports are **type-only** — see the ⭐ trap. |
| **Resilience fields** | `packages/schemas/src/shared/notificationResilience.ts` | `notificationResilienceFields()` — the 4 local fields (`status`/`tentativas`/`erro`/`processedAt`) every channel schema spreads. |
| **Channel schema** | `packages/schemas/src/notificac*.ts` | Wire fields + the spread block. Admin-only, **never** in `ALL_DOMAINS`. |
| **Collection handle** | `packages/data/src/admin/collections/notificac*.ts` | A 4-line `defineAdminCollection`. |
| **Channel adapter** | `apps/<channel>/lib/*/notificacao.ts` | `parseNotificationBody`, `process*`, the pipeline config, and thin public wrappers. |
| **Receiver** | `apps/<channel>/app/api/webhooks/<channel>/route.ts` | Verify → parse → enqueue → ack 200. |
| **Scheduler** | `apps/<channel>/lib/*/{ml,mp,wa}Tasks.ts` | The enqueue seam. **Stays per-app** — see the ⭐ trap. |
| **Triggers** | `apps/<channel>/functions/src/` | `onTaskDispatched` consumer + `onSchedule` sweep. |

Live channels: **mercado-livre**, **mercado-pago**, **whatsapp**. Not yet on the
pipeline: **melhor-envio** (processes inline, no queue/sweep — #360 follow-up).

## The flow

```
1. RECEIVE   POST /api/webhooks/<channel>
             verify signature (if the provider signs) → parseNotificationBody
             → scheduler.enqueue(payload) → 200 { received: true }
             NO FIRESTORE WRITE on the happy path.
             enqueue THREW? → persistNotificationFailure() → still ack 200.
                              (a 5xx can make a provider disable the topic)

2. TASK      onTaskDispatched(processXNotification), retryCount 0..2
             handleNotificationTask → pipeline.handleTask
               taskSchema.safeParse fails  → dropped   (coding bug; no persist)
               process() THREW             → transient: rethrow so the queue
                                             retries with backoff; on the FINAL
                                             attempt persist `failed` instead
               process() RETURNED          → toDisposition(outcome, payload, 'task')

3. SWEEP     onSchedule('every 30 minutes') → reprocessNotifications
             query status=='failed' && processedAt < now-1h
                   orderBy(processedAt) limit 50        ← the durable cursor
             per doc: dedup within the run → re-drive process()
                      → toDisposition(outcome, payload, 'sweep')
             every doc is isolated; one failure never aborts the batch
```

## The disposition matrix

`toDisposition` maps a channel's own outcome union onto four shared arms. **The
same arm means different writes in each phase** — that asymmetry is the point:

| arm | in the TASK | in the SWEEP | `outcomes` key |
| --- | --- | --- | --- |
| `resolve` | persist nothing (the cost win) | **DELETE** the doc | `label ?? 'done'` |
| `drop` | persist nothing | **DELETE** the doc | `label ?? 'dropped'` |
| `park` | create `status: 'parked'` | **mark** `parked` (terminal) | `'parked'` |
| `fail` | create `status: 'failed'` | mark `failed`, **park at the cap** | `failed`/`parked` |

- `resolve` vs `drop` write identically; they differ in the task's reported
  outcome (`done` vs `dropped`) and in the counter an operator reads. Use
  `resolve` for "we settled it", `drop` for "it was never ours" (a sandbox
  event, an unsupported topic).
- `label` keeps a channel's operator vocabulary (`reconciled`, `processed`).
- **Only `fail` is re-driven.** `park` is terminal — nothing sweeps it again.

## ⚠️ Traps

**`toDisposition` receives the PHASE, and it is not decoration.** Mercado Livre
is the live proof: an unparseable `resource` is `drop` in the task (no document
exists, and one isn't worth creating for an anomaly) but `park` in the sweep (a
document already exists and is kept as an audit row rather than deleted).
Collapsing the phases makes the sweep start **deleting rows it parks today**.

**`process` must RETURN deterministic outcomes and THROW transient ones.** That
single rule is what lets one function serve both a fresh queued task and a sweep
re-drive without knowing which it is in. Returning an error-ish outcome for a
transient failure kills the retry; throwing for a deterministic one burns the
whole retry budget and then dead-letters something that was never going to work.

**Narrow your errors in `process`, and check whether a provider failure is
really transient.** A dead OAuth grant and a 404 are deterministic → `fail` and
let a human reconnect. Network / 5xx / 429 are transient → throw. The shared
core's own catches narrow on bare `Error` *by design* (documented at the top of
`pipeline.ts`) — that exemption is for generic infrastructure and stops at the
channel boundary.

**Two deliveries of an id-less event produce two docs.** The failure doc is
keyed by the provider's event id; with no id the handle mints an auto id and the
`ALREADY_EXISTS` dedup cannot fire. The sweep's in-run dedup key is what bounds
the blast radius — pick one that actually identifies the work (`resource`,
`paymentId`, `messageId`), not the notification.

**A duplicate found by the sweep is SKIPPED, not deleted.** It stays for a later
run, in case the first copy's processing didn't cover it.

**Idempotency is the HANDLER's job, not the receiver's.** Nothing dedups at
enqueue time. Every `process` must be safe to run twice, keyed by the provider's
resource id — at-least-once is the delivery contract from both the provider and
Cloud Tasks.

**The region-qualified queue name is mandatory.** Without the
`locations/{region}/functions/{name}` prefix the Admin SDK targets
`us-central1` and the task is **silently dropped** — no throw, no log, no
delivery. App Hosting doesn't expose its own region, so `*_TASKS_REGION` must be
set and must match the function's deploy region.

**The function name IS the queue name.** The `export const` in `functions/src/`
must equal the `*_NOTIFICATION_QUEUE` constant; each app asserts this at module
load so a rename can't ship half-applied. Rename in both places.

## ⭐ The two things that bite hardest

**1. The correlated-outage escape hatch.** On the final attempt, a transient
failure is persisted so the sweep can re-drive it. But if that persist *also*
fails — the same Firestore outage we were recovering from — the core logs the
dropped notification and **re-throws the ORIGINAL error**, not the persist
error, so the failed attempt still surfaces in Cloud Tasks' metrics. Preserve
this if you ever touch `handleTask`; swallowing it makes an outage look clean.

**2. `@delfrance/data` must never import `firebase-admin` at runtime.** Every
`firebase-admin` import under `packages/data/src/admin/` is `import type` only,
and no module there calls `getFirestore`/`getFunctions` — they operate on the
`db` the app passes in. `packages/data/src/admin/adminBundleSafety.test.ts`
pins this. It is exactly why the per-channel Cloud Tasks schedulers
(`mlTasks`/`mpTasks`/`waTasks`) stay in their apps despite being near-identical:
unifying them needs a runtime `firebase-admin/functions` import.

## Add a new channel

1. **Schema** — `packages/schemas/src/notificacao<Canal>.ts`: the wire pointer
   fields plus `...notificationResilienceFields()`, `.passthrough()`.
   Export it as a **bare constant**, NOT a `{ schema, meta }` pair, and do
   **not** register it in `ALL_DOMAINS` — these collections are admin-only /
   default-deny, so the rules generator must emit no match block. (`registry.test.ts`
   flags any single export carrying both `.schema` and `.meta`.) Barrel-export it.
2. **Handle** — `packages/data/src/admin/collections/notificacao<Canal>Collection.ts`,
   a `defineAdminCollection({ path, schema })`; add it to that barrel.
3. **Index** — add to `firestore.indexes.json`:
   ```json
   { "collectionGroup": "notificacoes<Canal>", "queryScope": "COLLECTION",
     "fields": [ {"fieldPath":"status","order":"ASCENDING"},
                 {"fieldPath":"processedAt","order":"ASCENDING"} ] }
   ```
   ⚠️ **Do not skip this.** Firestore Enterprise auto-creates zero indexes and
   does **not** throw on an unindexed query — it silently full-scans and bills
   data scanned. The `delfrance/default-query-needs-index` lint does **not**
   cover these collections (they have no `meta.defaultQuery`), so nothing will
   catch the omission for you. No trailing `__name__` (Enterprise omits it).
4. **Adapter** — `apps/<canal>/lib/<dominio>/notificacao.ts`: a
   `parseNotificationBody`, a `process*` returning the channel's outcome union,
   then `defineNotificationPipeline({...})` and thin public wrappers. Build the
   pipeline **per call** so injectable deps stay per-call.
5. **Receiver** — `apps/<canal>/app/api/webhooks/<canal>/route.ts`: verify the
   signature (read the raw body ONCE — a re-serialized JSON won't match the
   HMAC), parse, enqueue, ack 200. Catch enqueue failure → `persistNotificationFailure`
   → still 200.
6. **Scheduler** — copy `waTasks.ts` (the simplest): the queue constant, the
   `*_TASKS_DISABLED=1` valve throwing a channel-specific error, `*_TASKS_REGION`.
7. **Functions** — `apps/<canal>/functions/src/`: the `onTaskDispatched`
   consumer (name === queue constant; `retryConfig.maxAttempts` === `TASK_MAX_ATTEMPTS`)
   and an `onSchedule('every 30 minutes')` sweep that logs `processed`/`outcomes`/
   `errors`. Add `firebase.<canal>.deploy.json`.
8. **Docs** — the app's `CLAUDE.md`, and its `functions/DEPLOY.md` with the
   one-time IAM grant (`roles/cloudtasks.enqueuer` + `roles/iam.serviceAccountUser`).

## Why not persist-first

Issue #360 originally specified persist-first: write every notification, mark
`processedAt` on success, never delete. The repo deliberately went the other
way, and the reasoning is recorded in
`packages/schemas/src/notificacaoMercadoLivre.ts` and the ML receiver route:
keeping every notification purely to fire a Firestore trigger was **a write per
notification** in pure cost, and an ungated create-trigger gave **no control
over the provider's API call rate** — which the task queue's `rateLimits` now
provides. The failures-only store plus a durable cursor gives the same replay
and audit guarantees for the events that actually need them.

## Testing

Each channel keeps its own suite against a hand-rolled `FakeDb` (they differ per
channel — ML needs `collectionGroup`, WhatsApp needs `runTransaction` — so the
harness is deliberately **not** shared). The shared core has its own generic
contract tests in `packages/data/src/admin/notifications/pipeline.test.ts`
against a synthetic channel; add to those when you change the core, not to a
channel's suite.

Cover per channel: a resolved notification persists **nothing**; each terminal
disposition writes the right status; a transient throw re-throws below the cap
and persists at it; the correlated-outage case re-throws the original; the sweep
deletes/parks/bumps correctly and isolates per-doc failures.

The emulator cannot run this end-to-end (Cloud Tasks isn't emulated) — unit
tests against the fake are the contract.

## Reference

**Constants** (`@delfrance/data/admin/notifications`): `TASK_MAX_ATTEMPTS = 3`
(keep in sync with the function's `retryConfig.maxAttempts`), `MAX_TENTATIVAS = 5`
(sweeps before parking), `ONE_HOUR_MS` (sweep window),
`DEFAULT_REPROCESS_LIMIT = 50`.

**Env per channel**: `<CANAL>_TASKS_DISABLED=1` → sweep-only mode (the receiver
persists instead of enqueuing — never a silent drop); `<CANAL>_TASKS_REGION`
(falls back to `FUNCTIONS_REGION`, default `us-east5`).

**Signature posture today** — verify before copying a pattern: WhatsApp is
mandatory-fail-closed (`X-Hub-Signature-256`; secret unset → 503); Melhor Envio
is mandatory (`X-ME-Signature`); Mercado Pago is **skipped when the secret is
unset**; Mercado Livre has **none at all** (ML doesn't sign — the trust anchor is
refetch-before-mutate). The last two are known gaps, not models to follow.

**Key files**

- `packages/data/src/admin/notifications/{pipeline,store,types,coerce}.ts`
- `packages/data/src/admin/adminBundleSafety.test.ts`
- `packages/schemas/src/shared/notificationResilience.ts`
- `apps/{mercado-livre/lib/marketplace,mercado-pago/lib/payments,whatsapp/lib/whatsapp}/notificacao.ts`
- `apps/{mercado-livre,mercado-pago,whatsapp}/functions/src/index.ts` + `DEPLOY.md`
- `firestore.indexes.json` (the three `notificacoes*` composite indexes)
