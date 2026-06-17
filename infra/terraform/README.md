# infra/terraform — NF-e async reconciler (Cloud Tasks)

The repo's **first Terraform**. Provisions the Cloud Tasks queue + dedicated
OIDC service account the NF-e emitter uses to schedule consult tasks against
`apps/nfe`'s `POST /api/nfe/reconciliar` (the async reconciliation from PR #186).

Scope is deliberately tiny: one queue, one SA, three additive IAM bindings, one
API enablement — all inside a single named project. It is structured so other
infra modules can be added later without broadening these grants.

## What it creates

- `google_project_service.cloudtasks` — enables `cloudtasks.googleapis.com`.
- `google_cloud_tasks_queue.nfe_consulta` — the reconcile queue (conservative
  rate/retry).
- `google_service_account.nfe_task_runner` — OIDC identity the queue impersonates.
- IAM (`*_iam_member`) — runtime SA → `cloudtasks.enqueuer` +
  `serviceAccountUser`; Cloud Tasks agent → `serviceAccountTokenCreator` on the
  runner SA.

Outputs (`terraform output -json`): `queue_path`, `reconcile_endpoint`,
`task_runner_sa_email`, and `nfe_tasks_env` (the ready-to-apply `NFE_TASKS_*`
map). The deploy wires those into the `apps/nfe` App Hosting backend env; with
PR1's fail-fast (`NFeTasksConfigError`) that makes a half-configured deploy
impossible.

## Safety rules (why this can't touch other projects/resources)

1. **`var.project_id` has no default.** Every `plan`/`apply` must name the
   project — you can't accidentally apply to the wrong one.
2. **Additive IAM only** — `*_iam_member`. **Never** `*_iam_policy` /
   `*_iam_binding` (authoritative — they overwrite every other binding).
3. **GCS remote backend with a per-project `prefix`** (`backend.hcl`) → state is
   isolated per project; no cross-project state bleed.
4. **`prevent_destroy`** on the queue + runner SA.
5. **No `google_project` / `google_folder` / `google_organization_*`** — the
   module only manages resources *inside* `var.project_id`.
6. Run with a **project-scoped** credential (least privilege), never an
   org-wide ADC.

## Usage

```bash
cd infra/terraform

cp backend.hcl.example backend.hcl            # set bucket (same project) + prefix
cp terraform.tfvars.example prod.tfvars       # set project_id, runtime SA, backend URI

terraform init -backend-config=backend.hcl
terraform plan  -var-file=prod.tfvars
terraform apply -var-file=prod.tfvars

# Wire the outputs into the apps/nfe backend env (NFE_TASKS_*):
terraform output -json nfe_tasks_env
```

`apply` stays **manual + coordinated** (like the Firestore-rules deploy) — CI
only runs `fmt -check` + `validate`, never `apply`.

## Bootstrap note (the App Hosting URI)

`reconcile_endpoint` is derived from `var.nfe_backend_uri` (the App Hosting
backend's public URL — stable across redeploys), so no chicken-and-egg: the
backend exists before you set this. If you'd rather Terraform read the URI
automatically, import the `google_firebase_app_hosting_backend` and swap
`var.nfe_backend_uri` for its `.uri` attribute — the input-variable form is the
simpler default and avoids managing the backend's full lifecycle here.

## Until this is applied

`apps/nfe` runs **sweep-only**: with `NFE_TASKS_*` unset, set
`NFE_TASKS_DISABLED=1` so the emitter doesn't fail fast — the backstop sweep
(`processar-pendentes`) still reconciles, just slower. Once the queue is applied
and the env wired, Cloud Tasks becomes the primary trigger.
