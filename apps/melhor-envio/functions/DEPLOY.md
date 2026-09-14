# Melhor Envio notification Functions

This codebase receives notification tasks dispatched by the Melhor Envio App
Hosting backend and retries persisted failures on a 30-minute schedule.

## Exports

- `processMelhorEnvioNotification`: Cloud Tasks handler for the
  `processMelhorEnvioNotification` queue.
- `reprocessMelhorEnvioNotifications`: scheduled sweep for `failed` and
  `deferred` notification rows.

## Required configuration

The build requires `FUNCTIONS_REGION` and `TASKS_INVOKER_SA`. Both exported
functions bind the `MELHOR_ENVIO_CLIENT_ID` and `MELHOR_ENVIO_CLIENT_SECRET`
secrets because every notification may refresh OAuth before consulting the
current label state. Grant the runtime service account access to exactly those
two secrets.

Runtime non-secret configuration belongs in
`apps/melhor-envio/functions/.env.deploy.<project-id>` (copy the documented
values from `.env.example`):

- `MELHOR_ENVIO_SANDBOX=true|false` is mandatory and has no implicit default;
- `MELHOR_ENVIO_PUBLIC_URL` is mandatory and must be an absolute HTTP(S) origin;
- `MELHOR_ENVIO_USER_AGENT` is optional and keeps the application fallback.

The App Hosting
backend uses `MELHOR_ENVIO_TASKS_REGION`, falling back to `FUNCTIONS_REGION`,
to address the regional queue. Set `MELHOR_ENVIO_TASKS_DISABLED=1` while the
queue is not ready; enqueue failures are then persisted for the sweep.

The runtime service account needs access to Firestore. The App Hosting service
account needs `roles/cloudtasks.enqueuer` and
`roles/iam.serviceAccountUser` on `TASKS_INVOKER_SA`. The invoker service
account needs `roles/run.invoker` on the task function.

## Manual rollout

No deployment is performed by this change. In the coordinated operations
window:

1. Deploy the notification sweep index and the
   `pedidos.freteInicial.printLabelId` lookup index.
2. Configure the region, `TASKS_INVOKER_SA`, both secrets, and the three
   non-secret Melhor Envio runtime values above.
3. Build and deploy with `firebase.melhor-envio.deploy.json`.
4. Verify the Cloud Tasks, invoker, Firestore, and Secret Manager grants.
5. Configure the App Hosting backend's task region.
6. Verify queue dispatch, authoritative label lookup, structured task logs,
   persisted `failed`/`deferred` rows, and both sweep lanes.
   results.
7. Remove `MELHOR_ENVIO_TASKS_DISABLED` only after dispatch is healthy.

Monitor final task failures, dispatch `403` responses,
`notificacoesMelhorEnvio` rows in `failed` or `parked`, and sweep outcomes.
