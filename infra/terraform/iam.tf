# IAM for the NF-e reconcile queue + task-runner SA.
#
# CARDINAL SAFETY RULE: additive `*_iam_member` resources ONLY. Never
# `*_iam_policy` or `*_iam_binding` — those are authoritative and would
# overwrite every other binding on the queue / SA / project, wiping unrelated
# access. `_member` grants one role to one principal and leaves the rest alone.

# The apps/nfe runtime SA may enqueue tasks on the reconcile queue.
resource "google_cloud_tasks_queue_iam_member" "runtime_enqueuer" {
  project  = var.project_id
  location = google_cloud_tasks_queue.nfe_consulta.location
  name     = google_cloud_tasks_queue.nfe_consulta.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${var.nfe_runtime_sa_email}"
}

# The apps/nfe runtime SA may set the task-runner SA as a task's OIDC identity
# (specifying serviceAccountEmail in a task requires actAs on that SA).
resource "google_service_account_iam_member" "runtime_acts_as_runner" {
  service_account_id = google_service_account.nfe_task_runner.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.nfe_runtime_sa_email}"
}

# The Cloud Tasks service agent mints the OIDC token for dispatch — it needs
# tokenCreator on the runner SA.
#
# GCP provisions the Cloud Tasks service agent lazily — after the API is enabled
# AND first used (the queue creation). Without ordering, the FIRST apply on a
# project that never used Cloud Tasks can fail here with "service account
# service-…@gcp-sa-cloudtasks… does not exist". `depends_on` the queue (which
# itself depends_on the API) materializes the agent before this binding. If a
# race ever survives that, `google_project_service_identity` (google-beta) is the
# bulletproof upgrade — kept out here to avoid a second provider.
resource "google_service_account_iam_member" "cloudtasks_agent_token_creator" {
  service_account_id = google_service_account.nfe_task_runner.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"

  depends_on = [google_cloud_tasks_queue.nfe_consulta]
}

# NOTE: no Cloud Run invoker grant. The apps/nfe backend is public (the web app
# calls it with a Firebase token), and /api/nfe/reconciliar enforces OIDC at the
# application layer via verifyServiceCaller (audience + email allow-list), so it
# does not rely on Cloud Run IAM.
