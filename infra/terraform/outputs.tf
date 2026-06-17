# Outputs feed the deploy script, which sets the apps/nfe App Hosting backend's
# NFE_TASKS_* env from `terraform output -json`. Together with PR1's fail-fast
# (NFeTasksConfigError), this makes a half-configured deploy impossible.

output "queue_path" {
  description = "Full Cloud Tasks queue resource path → NFE_TASKS_QUEUE."
  value       = google_cloud_tasks_queue.nfe_consulta.id
}

output "task_runner_sa_email" {
  description = "OIDC runner SA email → NFE_TASK_RUNNER_SA (and NFE_TASK_SA_EMAILS)."
  value       = google_service_account.nfe_task_runner.email
}

output "reconcile_endpoint" {
  description = "Absolute reconcile URL → NFE_TASKS_ENDPOINT (also the OIDC audience)."
  value       = "${trimsuffix(var.nfe_backend_uri, "/")}/api/nfe/reconciliar"
}

output "nfe_tasks_env" {
  description = "Ready-to-apply NFE_TASKS_* env map for the apps/nfe backend."
  value = {
    NFE_TASKS_QUEUE    = google_cloud_tasks_queue.nfe_consulta.id
    NFE_TASKS_ENDPOINT = "${trimsuffix(var.nfe_backend_uri, "/")}/api/nfe/reconciliar"
    NFE_TASK_RUNNER_SA = google_service_account.nfe_task_runner.email
    NFE_TASK_SA_EMAILS = google_service_account.nfe_task_runner.email
  }
}
