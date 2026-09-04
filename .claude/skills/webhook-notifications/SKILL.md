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
| **Shared core** | `packages/data/src/admin/notifications/` (`@delfrance/data/admin/notifications`) | `defineNotificationPipeline` (the whole disposition matrix + sweep), `createNotificationStore` (the 4 writes), the receiver coercers `asInt`/`asMillis`, the constants. Firestore imports are **type-only** — see the ⭐ trap. |
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

3b. SLOW LANE  same onSchedule → reprocessDeferredNotifications
             query status=='deferred' && processedAt < now-24h   ← SAME index
             identical loop; the 24h window IS the per-doc cadence, so at a
             30-min schedule it returns nothing 47 runs out of 48
             + a channel that can OBSERVE the precondition clearing calls
               pipeline.redrive(docId) to jump the doc back into the hot lane
```

## The two retry lanes

`failed` and `deferred` are **two lanes over one collection**, told apart by
`status` alone and sharing one `(status, processedAt)` composite index:

| lane | window | cap | for |
| --- | --- | --- | --- |
| **hot** `failed` | 1 h | `MAX_TENTATIVAS = 5` → `parked` | the work failed; retry shortly |
| **slow** `deferred` | 24 h | `MAX_TENTATIVAS_DEFERRED = 7` → `parked` | a precondition outside this system is not met **yet** |

**Pick the lane by WHO can clear the blockage, not by severity.** `fail` = we
could not do it, try again shortly. `defer` = a human has to do something first
(connect an account, re-grant a credential), and that may be tomorrow. Using
`fail` for a precondition is issue **#808**: a Mercado Livre notification for an
unconnected seller burned its 5 hourly retries and parked ~6h in, terminally, so
a next-business-day connect silently lost every order, payment and shipment that
had arrived. A deferred doc costs **zero** hot-lane retries while it waits.

## The disposition matrix

`toDisposition` maps a channel's own outcome union onto five shared arms. **The
same arm means different writes in each phase** — that asymmetry is the point:

| arm | in the TASK | in the HOT sweep | in the DEFERRED sweep | `outcomes` key |
| --- | --- | --- | --- | --- |
| `resolve` | persist nothing (the cost win) | **DELETE** the doc | **DELETE** the doc | `label ?? 'done'` |
| `drop` | persist nothing | **DELETE** the doc | **DELETE** the doc | `label ?? 'dropped'` |
| `park` | create `status: 'parked'` | **mark** `parked` (terminal) | **mark** `parked` | `'parked'` |
| `fail` | create `status: 'failed'` | mark `failed`, **park at the cap** | **graduate** — `redrive` into the hot lane | `failed`/`parked`/`redriven` |
| `defer` | create `status: 'deferred'` | **migrate** to `deferred`, `tentativas: 0` | mark `deferred`, **park at the deferred cap** | `deferred`/`parked` |

- `resolve` vs `drop` write identically; they differ in the task's reported
  outcome (`done` vs `dropped`) and in the counter an operator reads. Use
  `resolve` for "we settled it", `drop` for "it was never ours" (a sandbox
  event, an unsupported topic).
- `label` keeps a channel's operator vocabulary (`reconciled`, `processed`).
- `park` is terminal — **nothing** in the repo ever re-drives a parked doc.
- A `fail` in the DEFERRED lane means the precondition finally cleared and the
  work itself failed: the doc rejoins the hot lane with a **fresh** budget
  (`tentativas: 0`, `processedAt: 0`) rather than spending a horizon it no longer
  needs.
- `NotificationPhase` stays `'task' | 'sweep'` — the deferred lane also asks as
  `'sweep'`, because the question a channel answers there is "does a document
  exist yet", and in both sweeps it does.

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
   cover these collections (they have no `meta.defaultQuery`). CI enforces both
   the composite index **and** that the handle is wired into
   `defineNotificationPipeline` via
   `packages/data/src/admin/notifications/notificationGuardrails.test.ts`
   (#684) — skipping either step reds the `@delfrance/data` suite. No trailing
   `__name__` (Enterprise omits it).
4. **Adapter** — `apps/<canal>/lib/<dominio>/notificacao.ts`: a
   `parseNotificationBody`, a `process*` returning the channel's outcome union,
   then `defineNotificationPipeline({...})` and thin public wrappers. Build the
   pipeline **per call** so injectable deps stay per-call.

   ⭐ **`parseNotificationBody` NORMALIZES, then `safeParse`s — it never
   hand-builds the payload literal.** Coerce the named wire fields with the
   shared `asInt`/`asMillis` and spread the rest, so the parse is *total* for
   any body that clears the routing-field gate and the schema acts as the type
   gate rather than the trust boundary (that is re-fetching the resource from
   the provider). A hand-built literal enumerates keys, which silently strips
   everything the provider added and makes the `.passthrough()` on both the
   task and collection schemas dead for anything the receiver produced — the
   dead-letter row goes lossy exactly when it is the only surviving evidence.
   That was **#810** in Mercado Livre. Two traps it also covers: the payload
   feeds `docIdOf`, so an id taken from the body is a Firestore **path** unless
   you reject `/`, `.`, `..` and `__x__`; and the remainder is unauthenticated
   JSON heading for a Cloud Tasks enqueue and a Firestore document, so bound it
   (non-scalar → JSON text, reserved/empty field names dropped, byte budget) —
   an `INVALID_ARGUMENT` there is not a `ZodError`, so the receiver rethrows it
   as a 5xx and the provider disables the topic.

   ⭐ **`docIdOf` returning null is a dedup hole, not a neutral default.** The
   store falls back to an auto id, so `create`'s ALREADY_EXISTS collision — the
   only thing stopping a failure doc from forking — never fires, and a
   repeatedly-failing resource accumulates one dead document per attempt. That is
   tolerable while every id comes off the provider's wire, and stops being
   tolerable the moment the channel gains a producer that SYNTHESISES
   notifications (a backfill sweep, a missed-deliveries replay): those carry no
   provider event id by construction. Derive one — Mercado Livre uses
   `<topic>:<resource>`, routed back through the same doc-id guard so a malformed
   value still degrades to an auto id (**#807**). Put `topic` in the key when two
   topics can share a resource, and use the WHOLE resource: a last-segment key
   collides `/orders/7` with `/shipments/7`.
5. **Receiver** — `apps/<canal>/app/api/webhooks/<canal>/route.ts`: verify the
   signature (read the raw body ONCE — a re-serialized JSON won't match the
   HMAC), parse, enqueue, ack 200. Catch enqueue failure → `persistNotificationFailure`
   → still 200.
6. **Scheduler** — copy `waTasks.ts` (the simplest): the queue constant, the
   `*_TASKS_DISABLED=1` valve throwing a channel-specific error, `*_TASKS_REGION`.
7. **Functions** — `apps/<canal>/functions/src/`: the `onTaskDispatched`
   consumer (name === queue constant; `retryConfig.maxAttempts` === `TASK_MAX_ATTEMPTS`)
   and an `onSchedule('every 30 minutes')` sweep that logs `processed`/`outcomes`/
   `errors`.

   ⭐ **The consumer's ONE `logger.info` must carry the channel's `ProcessOutcome`
   `kind`, and a `detail` wherever a handler has an outcome worth reporting** — plus
   the payload's own ids read off the **raw** `req.data`, which is what makes them
   survive the schema-parse drop (there `r.payload` and `r.result` are both absent).
   `outcome: 'done'` is a **disposition**, not a claim that work happened: an items
   sync that found no link and one that rewrote the listing both resolve to it, and
   on Mercado Livre that ambiguity cost a full day of the first live run (#1087 →
   #1136, ported to the other two channels in #1137). Project them with a
   **structural `'x' in r.result` check, never an arm enumeration** — enumerating is
   what silently stops covering an arm that later gains the field. Use `?? null`:
   Cloud Logging drops `undefined` keys, so a key filterable-as-absent beats a key
   that vanishes. One call, not several — the fields land in `jsonPayload` and are
   filterable (`jsonPayload.detail="no-link"`), so more fields beat more lines.
   ⚠️ `detail` belongs on the `resolve`/`drop` arms and NOT on `fail`: a `fail`
   writes a Firestore doc carrying the whole reason as `erro`, so the record already
   exists, while `done` and `dropped` persist nothing and the log is all there is.
   ⚠️ Never log a raw provider body — WhatsApp's change `value` carries message
   content, so its handler narrows `req.data` to the two id keys rather than
   spreading it. Add `firebase.<canal>.deploy.json`. **Copy `src/tasksInvoker.ts`
   verbatim from another codebase, spread `...tasksInvokerOptions()` into the
   options, and add the `process.env.TASKS_INVOKER_SA` `define` to `build.mjs`**
   (#1133) — `packages/config-eslint/rules/tasks-invoker-inventory.test.js` reds
   CI until all three are done.
8. **Docs** — the app's `CLAUDE.md`, and its `functions/DEPLOY.md` with the
   one-time IAM grant. **Three roles, not two**: `roles/cloudtasks.enqueuer` and
   `roles/iam.serviceAccountUser` cover ENQUEUING, and `roles/run.invoker` on each
   task function's Cloud Run service covers DISPATCH. The third is the one that
   gets forgotten, and it fails invisibly - the enqueue succeeds, so no failure
   document is written, and the task 403s inside Cloud Tasks with the only
   evidence in the function's own log. Cost the first ML live run a full day.

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

Also cover the **`kind`/`detail` contract at `handleNotificationTask`** — at minimum
one success arm and one non-success arm, plus a set-distinctness assertion over the
outcomes that share a disposition (that set IS the property; "detail is present" is
not). **Mutation-prove them**: delete the field again and confirm exactly those tests
go red while the rest stay green, or they regress silently, which is the whole
failure mode. The log line itself is pinned one layer up in
`functions/src/processNotification.test.ts` by spying on the package-root `logger`
and invoking the exported function through `.run(req)` — see the three channels'
copies.

A channel with a `defer` arm additionally needs the **precondition-clears-later**
path end to end, since that is the one #808 lost: task defers → the hot sweep
never touches it however many times it runs → the precondition clears → the doc
imports. Assert the deferred cap **by constant** (`MAX_TENTATIVAS_DEFERRED - 1`
parks on its next re-drive) so retuning the horizon stays a one-constant edit.
`store.redrive` is `mergeIfExists`, i.e. `update()`, so the FakeDb needs a `doc()
.update` that raises gRPC **5** for an absent doc — a `set`-based stand-in would
pass a test that upserts a ghost in production.

The **Cloud Tasks hop IS emulatable**, and Mercado Livre now covers it end to end
(`ci-mercado-livre.yml`, `*.tasks.test.ts`): receiver → `enqueue()` → tasks
emulator → the real `onTaskDispatched` → a real Firestore write.

⚠️ Two earlier claims here were wrong, so do not re-derive them: there IS a
`tasks` emulator (`firebase emulators:start --only tasks`), and the URI-format
bug that would have blocked us —
[firebase-admin-node#2725](https://github.com/firebase/firebase-admin-node/issues/2725),
where the emulator 404'd `locations/<region>/functions/<name>` — was **closed
2024-10-11 and fixed in firebase-admin 12.7.0**. This repo pins 14.2.0. So the
region-qualified name every `{ml,mp,wa}Tasks.ts` uses is **both** the
production-correct and the emulator-correct form; no seam or bare-name variant
is needed.

To emulate it: the **functions** emulator must run alongside `tasks` (it is what
registers the queues from the trigger definitions), the enqueuer's region must
match the region inlined into the functions bundle, and you must **not** pass
`opts.uri` — under the emulator the Admin SDK deliberately sends an empty URL
that the emulator back-fills, so a supplied uri ships the task to production.

The one genuine residue is
[firebase-tools#8254](https://github.com/firebase/firebase-tools/issues/8254)
(**open**, triaged upstream as a feature request): the dispatch loop is pure
FIFO with no `scheduleTime` predicate, so `scheduleDelaySeconds` is ignored.
Assert that option statically off `__endpoint` and keep round-trip tests on a
no-delay topic. `retryConfig` and `rateLimits` ARE emulated.

⚠️ **Mercado Pago and WhatsApp have no such lane** — their schedulers are
byte-identical copies of ML's, so the pattern ports directly.

What the fake is no longer the only evidence for, **on Mercado Livre only**
(`ci-mercado-livre.yml`, `*.firestore.test.ts`): the store's Firestore-level
assumptions now run against a real Firestore — `create()` really raising
ALREADY_EXISTS, `mergeIfExists` really getting NOT_FOUND rather than upserting a
ghost, and the lane query's treatment of a missing vs a `null` `processedAt`
(both excluded — range filters skip nulls, so the fake's `typeof v === 'number'`
guard matches production). The receiver is exercised end to end through the
`*_TASKS_DISABLED` valve into a real failure document.

⚠️ **Mercado Pago and WhatsApp have no such lane** — their pipelines rest
entirely on their fakes. If you are changing shared code in
`@delfrance/data/admin/notifications`, the ML lane is the only place a real
Firestore will contradict you.

## Reference

**Constants** (`@delfrance/data/admin/notifications`): `TASK_MAX_ATTEMPTS = 3`
(keep in sync with the function's `retryConfig.maxAttempts`), `MAX_TENTATIVAS = 5`
(hot sweeps before parking), `MAX_TENTATIVAS_DEFERRED = 7` (daily deferred
re-drives before parking, i.e. a one-week horizon), `ONE_HOUR_MS` (hot window),
`ONE_DAY_MS` (deferred window), `DEFAULT_REPROCESS_LIMIT = 50`.

**Env per channel**: `<CANAL>_TASKS_DISABLED=1` → sweep-only mode (the receiver
persists instead of enqueuing — never a silent drop); `<CANAL>_TASKS_REGION`
(falls back to `FUNCTIONS_REGION`; there is no default — an unset value throws).

**Signature posture today** — verify before copying a pattern: WhatsApp is
mandatory-fail-closed (`X-Hub-Signature-256`; secret unset → 503); Melhor Envio
is mandatory (`X-ME-Signature`); Mercado Pago is **skipped when the secret is
unset** — a known gap, not a model to follow.

**Mercado Livre signs nothing, and this is settled** (#811, re-verified against
the 03/08/2026 Notificações reference): no `x-signature`, no timestamp, no
manifest, no shared secret; the app manager offers only the OAuth
`Client_Id`/`Secret_Key` pair. The `ts=…,v1=…` scheme every web search surfaces
is **Mercado Pago**, a different product — don't port it. The trust anchor is
refetch-before-mutate; the only inbound check is
`apps/mercado-livre/lib/marketplace/notificacoes/webhookOrigin.ts`, an `application_id`
comparison (foreign ⇒ 403 pre-enqueue) that fails OPEN when unconfigured or when
the field is absent, because ML disables a topic after ~1h of non-200. ML's
published notification source IPs were considered and **declined** — an
undocumented rotation would reject every genuine notification. A temporary
header-name inventory settled the signature question from live traffic (no
signature header of any kind) and was then removed — the pattern worth copying
for a new channel is *observe rather than guess*, and then delete the probe once
it has answered.

**Adding a receiver for a new channel?** Establish the signature posture from the
provider's *notification* reference, not its security-recommendations page — the
latter tends to carry generic "validate the webhook signature with HMAC-SHA256"
advice aimed at integrators, which is what sent #811 looking for a Mercado Livre
signature that does not exist.

**Key files**

- `packages/data/src/admin/notifications/{pipeline,store,types,coerce}.ts`
- `packages/data/src/admin/notifications/notificationGuardrails.test.ts` (B+C: every `notificacoes*` handle has a pipeline consumer + sweep index)
- `packages/data/src/admin/adminBundleSafety.test.ts`
- `packages/schemas/src/shared/notificationResilience.ts`
- `apps/{mercado-livre/lib/marketplace,mercado-pago/lib/payments,whatsapp/lib/whatsapp}/notificacao.ts`
- `apps/{mercado-livre,mercado-pago,whatsapp}/functions/src/index.ts` + `DEPLOY.md`
- `firestore.indexes.json` (the three `notificacoes*` composite indexes)
