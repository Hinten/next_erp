---
title: 0013 — Firebase project migration (legacy prod → a new Enterprise project)
description: How the production data leaves the legacy Flutter project for a new Firestore Enterprise project with its own billing — the phase order, the still-open region decision, why the freeze can be short, what an export silently leaves behind, and what this licenses during development.
---

## Context

This repo runs against the **staging** Firebase project. The business data does
not live there. It lives in the **legacy Flutter production project**, on
Firestore **Standard** edition, where the Flutter app is its **sole** live writer.
⚠️ That is a fact about *that* project only. The two apps never share a document,
there is no dual run, and the cutover turns the legacy app off rather than running
the two side by side — root `CLAUDE.md` rule 8. (ADR 0011 originally read this as
a concurrent writer on *our* documents; see its Correction.)

That data has to move exactly once, and the destination cannot be the project it
is already in. A database's **edition is fixed at creation** — there is no
in-place Standard → Enterprise conversion — and this codebase is built on
Enterprise semantics: the Pipelines API, `FieldValue.maximum`/`minimum`, zero
auto-created indexes, billing by data scanned. A separate project also buys the
thing that motivated the move in the first place: **its own billing account**, so
the ERP's real running cost is a number someone can read rather than a share of a
line item.

So the shape is fixed: a **new project**, Firestore **Enterprise**, dedicated
billing, and a one-time cutover. Staging is not a source and not a destination —
it is unchanged and stays the CI/e2e target.

| Project | Firestore | Role |
|---|---|---|
| `legacy-prod` | Standard, Flutter live writer | source; frozen, then retired |
| `staging` | Enterprise | untouched — CI/e2e target |
| **new prod** | **Enterprise**, own billing account | destination |

What makes this hard is not the data. Google's managed export/import moves
documents reliably. What is hard is everything an export **does not** carry, and
the order the rest has to happen in: indexes, TTL policies, PITR and backup
schedules do not travel; Cloud Tasks queues are created by a functions deploy;
`NEXT_PUBLIC_*` values are inlined at build time, so seven App Hosting backends
need rebuilding rather than reconfiguring; and four providers hold webhook URLs
that carry the project id.

## Decision

Managed **export/import** for Firestore, **Storage Transfer Service** for the
bucket, **`auth:export`/`auth:import`** for users, and a short freeze made short
by a PITR snapshot. Four operational phases (plus the pre-window Phase 0). **Agents never run any of this** — it is a
coordinated human operation, and every step below is a step a person takes.

### Phase 0 — before the window, no downtime

Do this weeks early. Nothing here is reversible in a hurry, and one item
(the dress rehearsal) is what turns the freeze length from a guess into a number.

1. **Create the project**, attach the dedicated billing account, and set budget
   and alert thresholds on day one. Cost visibility is the point of the exercise;
   wiring it after the first invoice is wiring it too late.
2. **Create the database**:
   `gcloud firestore databases create --database=default --edition=enterprise --location=<region>`.
   The id is literally `default`, not `(default)` — see the root `CLAUDE.md`
   Critical rule 1, and everything that passes it explicitly to `getFirestore()`.
   ⚠️ **`<region>` is a placeholder, not shorthand for a value already agreed.
   The region has NOT been decided** — the shortlist, the trade-off and the check
   to run first are *The region is not yet decided* below, and issue #1115 is
   where the choice gets made and recorded. Do not run this command before that
   issue carries an answer: the location is effectively permanent.
   The **Storage bucket must be created in that same region** or the gen2 Eventarc
   storage triggers break *silently*, with no error surfaced anywhere
   (`apps/functions/src/options.ts`).
3. **Deploy `firestore.indexes.json` before any data lands.** Enterprise
   auto-creates zero indexes and an unindexed query does not fail — it full-scans
   and bills data scanned, so the mistake surfaces on the invoice. Set **TTL
   policies, PITR and backup schedules** here too: an export carries none of them.
4. **Deploy `firestore.rules`** — the production ruleset. Never
   `firestore.e2e.rules`, which opens every `e2e_`-prefixed collection.
5. **Enable PITR on `legacy-prod`.** This is what makes a consistent
   `--snapshot-time` export possible, and it is the single reason the freeze can
   be measured in minutes rather than in "however long the export takes".
6. **Recreate Secret Manager entries, service accounts and IAM.** Cloud Tasks
   queues are not created by hand — the `onTaskDispatched` deploy provisions them.
7. **Put a custom domain in front of every webhook receiver.** This is the
   highest-leverage item on the list. App Hosting URLs carry the project id, so
   without a domain in front, Mercado Livre, Mercado Pago, Meta/WhatsApp and
   Melhor Envio each need a URL re-registration *inside* the window — four
   external consoles, on the clock, with provider-side propagation delays nobody
   controls. With it, the cutover is a DNS repoint and the next migration is free.
8. **Ship the drain valve** — a mode that forces every receiver to *park* 100% of
   inbound notifications instead of processing them. Build it on
   `defineNotificationPipeline` (`packages/data/src/admin/notifications/`) by
   forcing the disposition to `park`, so the existing `reprocessNotifications`
   sweep — durable cursor, per-doc isolation, in-run dedup, delete-on-resolve,
   park-at-cap — *is* the replay engine. Do not hand-roll a parking lot.
   ⚠️ **Melhor Envio is the outlier.**
   `apps/melhor-envio/app/api/webhooks/melhor-envio/route.ts` updates the pedido
   directly: no `notificacoes*` collection, no queue, no sweep. A label-status
   webhook lost during the window is simply gone. Onboarding it onto the pipeline
   is a prerequisite, not a nice-to-have.
9. **Dress rehearsal into a throwaway project.** The measured export → import
   wall clock *is* the downtime budget.

### ⚠️ The region is not yet decided

This is an **open decision**, tracked in issue #1115, and it blocks Phase 0 step 2.
Nothing below is a choice already made — it is the groundwork so the choice can be
made quickly and once. The location of a Firestore database cannot be changed after
creation, and an App Hosting backend's region is fixed when the backend is created,
so this is one of the few items in this ADR with no second attempt.

⚠️ **Nothing in the codebase may pre-empt it.** No `build.mjs` default, `.env*`
example, `apphosting.yaml` or workflow moves to a candidate region before #1115 is
answered. The current `us-east1` / `us-east5` split is the #1108 workaround and is
load-bearing for the live project — reverting it early breaks a working deploy to
settle a question that is not settled.

#### Run this first

The repo carries no `.firebaserc` and no Terraform, so it cannot answer where the
*current* project actually lives. A human runs:

```bash
gcloud firestore databases list --project <current-project-id>
gcloud storage buckets describe gs://<bucket> --format='value(location)'
firebase apphosting:backends:list --project <current-project-id>
```

⚠️ This also bounds what can be fixed *before* the window. If the current project's
Firestore sits in `us-east1` or `southamerica-east1` — neither of which has App
Hosting — then no arrangement of backends can be co-located with it, and its
inter-region data-transfer charge is **structural**. Only the new project can end it.

#### The shortlist, and why it is only two

Verified against Google's own location tables (August 2026). The binding constraint
is **Firebase App Hosting, which exists in six regions worldwide** — `us-central1`,
`us-east4`, `us-east5`, `asia-east1`, `asia-southeast1`, `europe-west4` — and seven
backends need it.

The full service matrix across the realistic candidates. Every row here is an
**availability** fact checked against Google's location tables — these are what decide
the shortlist, and they are not estimates:

| | `us-central1` Iowa | `us-east1` S. Carolina | `us-east4` N. Virginia | `us-east5` Columbus | `southamerica-east1` São Paulo |
|---|---|---|---|---|---|
| **App Hosting** — 7 backends | ✅ | ❌ | ✅ | ✅ | ❌ |
| **Cloud Tasks** — 10 queues | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Cloud Scheduler** — 12 jobs | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Firestore Enterprise + Pipelines** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Cloud Functions gen2** | ✅ Tier 1 | ✅ Tier 1 | ✅ Tier 1 | ⚠️ not listed Tier 1; deploys in practice | ✅ |
| **Eventarc · Cloud Storage · Secret Manager** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Viable for this project** | ✅ **yes** | ❌ | ✅ **yes** | ❌ | ❌ |

Two of the five survive, and both failures are single-service gaps rather than anything
about the regions themselves.

`us-east5` is not a hypothetical: it is what failed **11 of 15** Mercado Livre
functions on 2026-08-19 — the 5 `onTaskDispatched` plus the 6 `onSchedule`, while the
4 Firestore triggers deployed cleanly, and that asymmetry was the diagnosis. The repo
provisions **10 Cloud Tasks queues and 12 Cloud Scheduler jobs** in total.

⚠️ **`us-east1` is the expensive exclusion, and it is worth understanding why.** It
has Cloud Tasks, Cloud Scheduler, Firestore Enterprise and Tier-1 Functions; it sits on
the US East Coast, so its latency to Brazil is comparable to `us-east4`'s; and it is
one of the three **baseline-priced** US regions (with `us-central1` and `us-west1` — the
trio Google's Always Free quotas apply to), so it does **not** carry `us-east4`'s ~15%
premium. On every axis that matters it is `us-east4`'s equal or better — it is simply
not an App Hosting region, and seven backends need one. That is also where most of the
functions already run today, which is why the current layout looks so nearly right.
**If App Hosting ever reaches `us-east1`, this decision should be reopened.**

Both survivors cover everything this project uses: Firestore Enterprise **with the
Pipelines API**, the 128 declared composite indexes, App Hosting, Cloud Functions gen2
(both are Tier 1), Cloud Tasks, Cloud Scheduler, Eventarc + Pub/Sub, Cloud Storage,
Secret Manager, Artifact Registry and Cloud Build — and BigQuery, which nothing uses
today but which would have to be co-located if a Firestore→BigQuery stream is ever
added.

**Vertex AI is not a constraint in either direction.** `DEFAULT_AI_LOCATION` is
`'global'` (`packages/ai/src/admin/provider.ts`) because the shipped Gemini 3.x models
are served only at global/multi-region and **404 on any regional endpoint**,
`us-central1` included — a property of that model family, not of a region. So the
project region can neither remove AI capability nor add any, and AI traffic is billed
by tokens rather than by inter-region egress. The one thing `global` does not offer is
tuning, batch prediction and context caching; should those ever be wanted, `us-east4`
is a supported regional Vertex AI location (Vector Search yes, RAG Engine subject to
allowlisting).

#### The tie-break

Both pass every gate, so the decision is cost against latency:

| | `us-east4` — N. Virginia | `us-central1` — Iowa |
|---|---|---|
| Latency from São Paulo | **~115–130 ms** — the best any App Hosting region offers | ~150–165 ms |
| Cloud Functions / Cloud Run | Tier 1 — **identical price** | Tier 1 |
| Firestore Enterprise write units | `$0.30` / M (list) — **≈ +15%** | **`$0.26` / M — the base rate every published figure quotes** |
| Firestore Enterprise read units | scales with the same multiplier | `$0.05` / M |
| Cloud Storage Standard | `≈ $0.023` / GB-month — **≈ +15%** | `$0.020` / GB-month |
| `getFunctions().taskQueue()` fallback | fallback stays `us-central1`, so the #1108 **silent task drop** stays possible | fallback **is** the real region, so that failure mode becomes a no-op |
| New Firebase / Firestore features | usually later | usually first |

⚠️ **Confirm the rates in the console's pricing calculator before committing.** The
figures above come from published pricing summaries, not from a rate card read at
decision time, and the choice is permanent.

Two things the table is saying that are easy to miss. **Compute is a tie** — both are
Cloud Run Tier 1 and price identically, so the whole delta lands on Firestore and
Cloud Storage. And on Enterprise the billing unit is **data scanned**, which is this
project's dominant cost line, so a ~15% regional multiplier applies to the largest
number on the invoice, permanently.

The `us-central1` row deserves its weight too: when an enqueuer's region is missing or
mismatched the Admin SDK resolves `us-central1`, the queue does not exist there, and
the task is **silently dropped while the route still returns 200**
(`tools/deploy-env/preflight.mjs`, #1108). Choosing `us-central1` turns that trap into
a harmless default; choosing `us-east4` leaves it live and keeps the preflight
cross-check load-bearing.

So the trade is explicit: **`us-central1` is the cheaper region and the safer one;
`us-east4` buys ~30 ms per round trip for Brazilian operators and pays ~15% on
Firestore and Storage for it.** Neither is wrong — but "cheapest" and "lowest latency"
are not the same answer here, and the decision should not be recorded as though they
were.

⚠️ **Keep the magnitudes straight.** Consolidating into *one* region — whichever one —
is the change that removes the inter-region data-transfer charge entirely, because
same-region traffic between Google Cloud services is free. The `us-central1` vs
`us-east4` delta is a second-order ~15% on a subset of lines. Do not let the tie-break
delay the consolidation.

**Current leaning: `us-east4`**, accepting the ~15% for the latency. Not final: record
the outcome in #1115 before running Phase 0 step 2.

### Phase 1 — the freeze

1. Announce, then put the Flutter app read-only (or stop operators).
2. **Flip the drain valve.** Parked payloads are written **into the new project**,
   under a collection that does not exist in the source export. That is safe by
   construction: a Firestore import only writes documents present in the export
   and never deletes, so a fresh collection name cannot be clobbered by step 4.
3. **Export at a PITR timestamp** at or after the freeze:

   ```
   gcloud firestore export gs://<bucket> \
     --project=<legacy> --database=default --snapshot-time=<T0>
   ```

   ⚠️ A plain export is **not** a point-in-time snapshot — it may include writes
   made while it runs. `--snapshot-time` is what makes the result consistent, and
   therefore what lets the freeze end before the export does.
4. Grant the **new** project's Firestore service agent
   (`service-<NEW_PROJECT_NUMBER>@gcp-sa-firestore.iam.gserviceaccount.com`) read
   access on the export bucket. Cross-project export/import is supported; it is
   this grant that makes it work.

### Phase 2 — the move

1. **Firestore import**:

   ```
   gcloud firestore import gs://<bucket>/<prefix>/ \
     --project=<new> --database=default
   ```

   ⚠️ **An import fires no Cloud Functions triggers.** (Snapshot listeners *do*
   see the writes.) That is mostly a relief — no trigger storm, no double-charged
   side effects, no `onPedidoChanged` re-deriving history for every pedido
   at once. But it cuts the other way too: **nothing is recomputed on arrival**,
   so any state a trigger would normally derive has to already be in the export.
   Cost: one read per document exported, one write per document imported.
2. **Storage → Storage Transfer Service**, bucket to bucket. Run a seed transfer
   days early and a second pass inside the window; STS transfers are incremental
   by default, so the second pass moves only the delta. Preserve custom metadata
   so `firebaseStorageDownloadTokens` survives.
3. **Auth** → `firebase auth:export` from legacy, then `firebase auth:import`
   into the new project **with the legacy project's password hash parameters**
   (`--hash-algo=SCRYPT --hash-key --salt-separator --rounds --mem-cost`, read
   from the legacy console's *Password Hash Parameters*). Firebase generates
   these per project, so without them every existing password stops working.
   UIDs are preserved, which is not optional — Firestore documents and the
   permission claims both key off them. Re-mint custom claims afterwards.
4. **Rewrite the stored download URLs.** A one-time `tools/migrations` script,
   following that package's contract. Download URLs bake the bucket name in:
   `firebaseDownloadUrl()` in `packages/schemas/src/storage/storagePaths.ts`
   builds `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/…`, and the
   result is persisted — `arquivos.url`, and `conversa`'s `anexo_url`,
   `image_url`, `video_url`, `thumbnail_url`.
   ⚠️ The new project's default bucket is `<project>.firebasestorage.app`, **not**
   `<project>.appspot.com`, so `FIREBASE_STORAGE_BUCKET` and
   `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` must both be set explicitly — the
   `.appspot.com` fallback in `resolveStorageBucketName()` is wrong for this
   project and will resolve to a bucket that does not exist.

### Phase 3 — cut the traffic over

The order is load-bearing.

1. **Functions first**, all five codebases. That deploy is what provisions the
   Cloud Tasks queues. Point a receiver at the new project before its queue
   exists and every enqueue fails into the persist-for-the-sweep fallback — the
   `*_TASKS_DISABLED=1` valves exist for exactly this gap.
2. **Rebuild and deploy all seven App Hosting backends.** `NEXT_PUBLIC_*` values
   are inlined by Next at build time, so this is a rebuild, not an env swap.
   `turbo.json`'s `globalEnv` lists them and should bust the cache; confirm it
   did rather than assuming.
3. **Storage CORS.** `cors.json` carries localhost origins only today.
4. **Re-register webhook and OAuth URLs** with each provider — or repoint DNS, if
   Phase 0 step 7 landed.
5. **Rotate** GitHub secrets, `.env.example`, operator `.env.local`.
   ⚠️ Leave the emulator lanes' hardcoded `demo-erp` alone (`e2e-emulator.yml`,
   `ci-storage.yml`, `copilot-setup-steps.yml`) — those are offline by design.

### Phase 4 — drain and verify

1. **Flip the drain valve off** and let `reprocessNotifications` replay the
   backlog.
   ⚠️ Replayed payloads are hours old and re-drive the same handlers as fresh
   events. That is precisely ADR 0011 tier (2): a handler without an event-clock
   watermark will apply stale provider state over fresh state, and the replay is
   the largest burst of stale events this system will ever see. **Audit the
   handlers before flipping, not after.**
2. **Verify**: per-collection document counts legacy versus new, Auth user count,
   the STS job's object and byte report, and at least one pedido spot-checked end
   to end — document, its arquivos, its rendered URLs.
3. **Watch data scanned** for the first days. On Enterprise a missing index does
   not raise; it bills.

### Rollback

`legacy-prod` is never mutated, so rollback is "repoint the apps and re-register
the URLs" — right up until the first operator write lands in the new project.
That write is the point of no return, and it should be named out loud on the day
rather than discovered afterwards.

## Consequences

The window's existence is a **licence**, not only a cost. Because a cutover is
planned, development can settle data-shape changes with **one-time
`tools/migrations` scripts** and skip the gradual machinery — dual-shape reads,
compat branches, lazy backfill-on-read, a derived field kept in sync by a trigger
— that only earns its keep when there is no cutover to rely on. The root
`CLAUDE.md` turns that into a standing rule.

The price is a queue. Every such script is inert until a human runs it, so each
one needs a `needs-migration-window` issue or it is dead code that quietly rots;
and the queue is *ordered* — indexes, then rules, then data, then functions, then
apps.

What gets harder: the freeze is real downtime for a business that takes orders,
and its length is bounded by the export/import wall clock plus the Storage delta,
which is why the dress rehearsal is not optional. Four external provider consoles
sit on the critical path unless the custom domains land first. And the parked-
notification replay concentrates every stale-event hazard in ADR 0011 into a
single burst.

What gets easier, permanently: cost becomes legible, the Enterprise semantics the
code already assumes become true in production, and `guides/coexistence.md` stops
describing an arrangement that no longer exists.

## Alternatives considered

- **Dataflow `firestore-to-firestore` template** (`SOURCE_PROJECT_ID`,
  `DESTINATION_PROJECT_ID`, `READ_TIME`) — Google's other supported
  Standard → Enterprise path, cross-project and cross-region, and the right call
  if partial migration or in-flight transforms were needed. Rejected as the
  default: managed export/import has fewer moving parts, and the one transform we
  need (the URL rewrite) is better as a dry-runnable, unit-tested
  `tools/migrations` pass than as pipeline code. Worth keeping in the back
  pocket. Note it fails after one hour if PITR is off on the source — another
  reason Phase 0 step 5 is not optional.
- **Convert the existing database in place** — impossible. Edition is fixed at
  creation.
- **Dual-write or live replication during the window** — there is no first-party
  Firestore-to-Firestore CDC. A hand-rolled dual-write means two writers racing
  across two projects with no shared transaction, which is more risk than a short
  freeze buys back.
- **Keep the webhooks live and reconcile afterwards** — rejected. Melhor Envio
  has no replay path at all, and the Mercado Livre / Mercado Pago retry windows
  are short enough that "reconcile afterwards" means "reconstruct by polling".

## Status

Accepted.
