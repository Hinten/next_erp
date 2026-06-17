# NF-e async reconciler infrastructure — the Cloud Tasks queue + dedicated OIDC
# service account the emitter uses to schedule consult tasks against
# /api/nfe/reconciliar (see apps/nfe). IAM bindings live in iam.tf.
#
# Everything here is scoped to var.project_id. No google_project / google_folder
# / google_organization_* resources — this module manages resources INSIDE the
# named project, never the project itself.

# Project number — needed to address the Cloud Tasks service agent in iam.tf.
data "google_project" "this" {
  project_id = var.project_id
}

# Cloud Tasks API. disable_on_destroy=false so tearing down this module never
# disables an API another workload in the project may rely on.
resource "google_project_service" "cloudtasks" {
  service            = "cloudtasks.googleapis.com"
  disable_on_destroy = false
}

# The reconcile queue. Conservative pacing: the app-level attempt cap
# (MAX_RECONCILE_ATTEMPTS) is the real bound on SEFAZ consults; these limits
# just keep Cloud Tasks-level delivery retries (on a 5xx from the endpoint)
# from hammering. A cStat=656 returns 200 (no retry); only a transport 502
# rides this retry_config.
resource "google_cloud_tasks_queue" "nfe_consulta" {
  name     = var.queue_name
  location = var.region

  rate_limits {
    max_dispatches_per_second = 5
    max_concurrent_dispatches = 10
  }

  retry_config {
    max_attempts  = 5
    min_backoff   = "30s"
    max_backoff   = "300s"
    max_doublings = 3
  }

  depends_on = [google_project_service.cloudtasks]

  # The queue holds in-flight reconcile tasks; destroying it would strand them.
  lifecycle {
    prevent_destroy = true
  }
}

# Dedicated OIDC identity the queue impersonates when calling the reconcile
# endpoint. Least privilege: it is ONLY an audience/identity — it holds no
# project roles. The endpoint allow-lists its email (NFE_TASK_SA_EMAILS).
resource "google_service_account" "nfe_task_runner" {
  account_id   = var.task_runner_sa_id
  display_name = "NF-e Cloud Tasks runner (OIDC identity for /api/nfe/reconciliar)"

  lifecycle {
    prevent_destroy = true
  }
}
