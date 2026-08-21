# notificacoes — webhook ingestion, task queue, backstop sweeps

The inbound edge: ML calls us, we ack fast and enqueue, a Cloud Task does the
work, and two sweeps catch whatever the happy path missed. The resilience core
itself is shared — see `@delfrance/data/admin/notifications` and the
`webhook-notifications` skill.

⚠️ **This theme depends on nearly every other one.** `notificacao.ts` is the
topic dispatcher, so it imports `pedidos/`, `claims/`, `chat/`, `importacao/`
and `anuncios/`. That fan-out is one-directional and intended.

⚠️ **The traffic is not one-way, though — two modules here are imported back
IN**, and neither has anything to do with dispatch: `mlTasks.ts` (from
`estoque/` ×4, `preco/`, `nfe/`) and `notificacaoFrescor.ts` (from `chat/`).
With the dispatcher's own edge into `chat/`, that makes `chat/ ⇄ notificacoes/`
a genuine cycle. The `mlTasks.ts` edge is the load-bearing one: it is why a
shared `tasks/` folder cannot exist, and what would have to move first if this
theme were ever split.

- `notificacao.ts` — the ingestion core: `parseNotificationBody`, the
  dispatch-by-topic `processNotificationPayload`, and the
  `defineNotificationPipeline({...})` binding. Owns `TOPIC_DISPOSITION` and the
  DEFERRED lane (#808).
- `webhookOrigin.ts` — the receiver's only inbound origin check (#811). ML does
  not sign notifications, so this is an `application_id` comparison. It fails
  OPEN when unconfigured — a misconfigured backend must not stall the stream.
- `mlTasks.ts` — the Cloud Tasks scheduler for the notification processor.
  **Stays central**: 8 importers across four themes. The other four
  `ml*Tasks.ts` files are single-consumer wrappers and live in their own domain
  folders.
- `notificacaoFrescor.ts` — decides when an ML 404 may be acked versus retried
  (the transient-404 window).
- `missedFeedsSweep.ts` — the daily 05:00 `missed_feeds` backstop (#812). Asks
  ML what it failed to deliver and replays it onto the same queue. Keeps **no
  cursor**, deliberately.
- `orderBackfill.ts` — the 15-minute order-backfill sweep; enqueues discovered
  orders onto the same pipeline.
- `coldStartPolicy.test.ts` — no source sibling. Reads `apphosting.yaml` and
  pins `minInstances: 0`, the premise that makes the missed-feeds backstop
  necessary. ⚠️ Its `__dirname` path is depth-sensitive.
