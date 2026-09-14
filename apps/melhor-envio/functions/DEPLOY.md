# Melhor Envio notification Functions

This codebase receives notification tasks dispatched by the Melhor Envio App
Hosting backend and retries persisted failures on a 30-minute schedule.

## Exports

- `processMelhorEnvioNotification`: Cloud Tasks handler for the
  `processMelhorEnvioNotification` queue.
- `reprocessMelhorEnvioNotifications`: scheduled sweep for `failed` and
  `deferred` notification rows.

## Required configuration

The build requires `FUNCTIONS_REGION` and `TASKS_INVOKER_SA`. The App Hosting
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

1. Deploy the `(status ASC, processedAt ASC)` Firestore index.
2. Configure the region and `TASKS_INVOKER_SA`.
3. Build and deploy with `firebase.melhor-envio.deploy.json`.
4. Verify the three IAM grants above.
5. Configure the App Hosting backend's task region.
6. Verify queue dispatch, structured task logs, persisted failures, and sweep
   results.
7. Remove `MELHOR_ENVIO_TASKS_DISABLED` only after dispatch is healthy.

Monitor final task failures, dispatch `403` responses,
`notificacoesMelhorEnvio` rows in `failed` or `parked`, and sweep outcomes.
