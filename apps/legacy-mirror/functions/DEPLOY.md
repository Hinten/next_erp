# `legacy-mirror` — deploy and cutover runbook

> ⚠️ **Temporary, migration-only, and human-run.** This codebase is deployed into
> the **legacy Flutter project**, never into staging or the new project. Agents
> never run any command on this page (root `CLAUDE.md`, rule 8). Every step
> belongs to the migration runbook tracked in #1208 (ADR 0013, amendment
> 2026-11-26).

## What it does

Three `onDocumentWritten` triggers on the legacy `(default)` database, one per
document depth (`{c1}/{d1}`, `{c1}/{d1}/{c2}/{d2}`,
`{c1}/{d1}/{c2}/{d2}/{c3}/{d3}`). For every legacy write, the function:

1. re-reads the **current** source document (the event payload is ignored);
2. in a transaction on the new project's `default` database, compares the
   source commit clock (`updateTime`, or `readTime` for a deleted doc) with the
   per-path watermark in `_mirrorWatermarks`;
3. copies or deletes the document only if the observation is not older than the
   watermark, then advances the watermark.

Out-of-order delivery, duplicates and retries are harmless. Documents are copied
verbatim: legacy names (`movimento`, `relatorio`, `cce`) and legacy shapes arrive
exactly as the export would bring them, and the window's `tools/migrations`
scripts handle them afterwards.

**Cost** (us-east1 → new project, ~20k legacy writes/day): inside the Cloud Run
functions free tier. About $0.05/day of Firestore (one Standard read, one
Enterprise read unit and ~6 write units per event).

## Prerequisites

1. **The new project is ready**: the `default` Enterprise database exists,
   `firestore.indexes.json` and `firestore.rules` are deployed.
   ⚠️ **No functions and no App Hosting in the new project yet.** Its triggers
   would fire on every mirrored write (including the ones that call Mercado Livre
   and Shopee), and the `storage` codebase's orphan sweeps could delete
   transferred objects whose `arquivos` docs have not arrived yet.
2. **IAM**: the mirror runs as the legacy project's default compute service
   account. Let it write into the new project:

   ```sh
   gcloud projects add-iam-policy-binding <NEW> \
     --member=serviceAccount:<LEGACY_NUMBER>-compute@developer.gserviceaccount.com \
     --role=roles/datastore.user
   ```

3. **Target and credential policy**: create
   `apps/legacy-mirror/functions/.env.deploy.<LEGACY>` (gitignored by `.env.deploy*`):

   ```sh
   LEGACY_MIRROR_TARGET_PROJECT_ID=<NEW or TESTE>
   # deny = throwaway TEST project, copy = the real migration. No default.
   LEGACY_MIRROR_CREDENTIALS=deny
   ```

   `prepare-deploy.mjs` copies it into the artifact, so both `defineString` params
   resolve without a prompt. The function refuses to start if the target equals
   the project it runs in, or if the policy is anything but `deny` / `copy`.
   - **`deny`**: credential documents (`credentials.ts`: the ML / Melhor Envio /
     Mercado Pago / Shopee / Amazon / Loja Integrada token subcollections and the
     filial certificates) are never written, any copy already in the target is
     deleted, and the WhatsApp `permanent_token` / `pin` fields are stripped.
     Required for a test project: the ML and Melhor Envio refresh tokens are
     single-use, so one refresh there would cut production off.
   - **`copy`**: everything verbatim. Only for the real migration, whose project
     runs no functions until the switch.

   Only one target at a time. To move from the test run to the real run,
   redeploy with the new target and policy.

## Deploy (D-3, before the export)

```sh
export FUNCTIONS_REGION=us-east1   # the LEGACY database's location
firebase deploy --only functions:legacy-mirror \
  --config firebase.legacy-mirror.deploy.json --project <LEGACY>
```

`--only functions:legacy-mirror` touches this codebase only. If firebase-tools
offers to delete functions it does not know (the legacy app's own), answer **No**.

Check it works without writing anything to legacy: watch the function logs, and
count the watermarks in the new project growing as operators work.

## Seed, then close the gap

1. Pick **T0 after the deploy** (a whole minute). Enable PITR on legacy first.
2. Export at T0, copy to a bucket in the new database's location, import
   (ADR 0013 Phase 1–2 commands, with `--database='(default)'` on the export).
3. **Test project only:** the import brought the legacy credentials with it. Run
   `tools/migrations` `throwaway-credentials-scrub` now, before anything is
   deployed there.
4. The import overwrites documents the mirror already updated after T0 with their
   T0 version, and leaves the watermarks alone. Run the replay script
   (`tools/migrations`, `legacy-mirror-replay`) with the same `--credentials` as
   the mirror: it re-applies every watermark with a stamp after T0. The
   equal-stamp rule is what lets it repair those documents.
5. Verify counts per collection, legacy against new.

## Rehearsal checks (on the seed)

- **References**: compare a document holding a `DocumentReference` as imported
  (unchanged since T0) with one the mirror copied. The mirror rebinds references
  to the new database. If the import keeps the legacy project in them, decide
  which shape wins before the cutover.
- **Numbers**: an integer-valued double (`5.0`) comes back as integer `5` from the
  mirror. Firestore and the schemas treat both as numbers.
- **Skips**: `stale observation skipped` log lines are expected occasionally. A
  steady stream of them means two writers are racing on legacy.

## Cutover (D-day)

1. Freeze legacy writes (rules read-only, legacy functions and webhooks stopped,
   drain valve on).
2. Wait until the newest watermark stops moving and the function logs go quiet.
3. Run the replay script's verify mode.
4. Continue with ADR 0013 Phases 2–4.

## Afterwards

```sh
firebase functions:delete legacyMirrorDepth1 legacyMirrorDepth2 legacyMirrorDepth3 \
  --region us-east1 --project <LEGACY>
firebase firestore:delete _mirrorWatermarks --recursive --database default --project <NEW>
gcloud projects remove-iam-policy-binding <NEW> \
  --member=serviceAccount:<LEGACY_NUMBER>-compute@developer.gserviceaccount.com \
  --role=roles/datastore.user
```

Then delete `apps/legacy-mirror/`, `firebase.legacy-mirror.deploy.json`, its
`CODEBASES` row in `tools/deploy-env/preflight.mjs` and its entry in
`firestore-transaction-inventory.test.js`.

## Companion: Storage

Storage Transfer Service charges nothing for bucket-to-bucket transfers. You pay
only network ($0.02/GiB within North America) and Class A operations on the
destination ($0.005 per 1,000).

1. **Seed**, a few days early: a batch job from the legacy bucket to
   `<NEW>.firebasestorage.app`. Custom metadata (`firebaseStorageDownloadTokens`)
   is preserved by default — check one download URL after the URL rewrite.
2. **Keep it current**: an event-driven job. It runs until stopped and does
   **not** propagate deletes.

   ```sh
   gcloud pubsub topics create legacy-storage-events --project=<NEW>
   gcloud storage buckets notifications create gs://<LEGACY_BUCKET> \
     --topic=projects/<NEW>/topics/legacy-storage-events
   gcloud pubsub subscriptions create legacy-storage-sts \
     --topic=legacy-storage-events --ack-deadline=300 --project=<NEW>
   gcloud transfer jobs create gs://<LEGACY_BUCKET> gs://<NEW>.firebasestorage.app \
     --event-stream-name=projects/<NEW>/subscriptions/legacy-storage-sts --project=<NEW>
   ```

   The new project's STS service agent
   (`project-<NEW_NUMBER>@storage-transfer-service.iam.gserviceaccount.com`) needs
   read on the legacy bucket, write on the new one and `roles/pubsub.subscriber`
   on the subscription. Check the exact roles against Google's STS permissions
   page before the first run.

3. **Cutover**: stop the event job, then one final batch job with
   `--delete-from=destination-if-unique`. It copies anything missed and removes
   objects deleted at the source. Deploy the `storage` codebase only after that.
