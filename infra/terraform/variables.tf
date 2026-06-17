variable "project_id" {
  type        = string
  description = "GCP/Firebase project id this module manages. NO default — every plan/apply must name the project explicitly so it can never touch the wrong one."

  validation {
    condition     = length(var.project_id) > 0
    error_message = "project_id must be set explicitly (e.g. -var project_id=veste-france)."
  }
}

variable "region" {
  type        = string
  description = "Region for the Cloud Tasks queue. Should match the apps/nfe App Hosting backend region."
  default     = "us-east1"
}

variable "queue_name" {
  type        = string
  description = "Cloud Tasks queue id for the NF-e async reconciler."
  default     = "nfe-consulta"
}

variable "task_runner_sa_id" {
  type        = string
  description = "Account id (local part) of the dedicated OIDC service account the queue impersonates when calling /api/nfe/reconciliar."
  default     = "nfe-task-runner"
}

variable "nfe_runtime_sa_email" {
  type        = string
  description = "Email of the apps/nfe App Hosting RUNTIME service account — the identity that creates tasks. Gets cloudtasks.enqueuer on the queue + serviceAccountUser on the task-runner SA."

  validation {
    condition     = can(regex("^[^@]+@[^@]+\\.iam\\.gserviceaccount\\.com$", var.nfe_runtime_sa_email))
    error_message = "nfe_runtime_sa_email must be a service-account email (…@<project>.iam.gserviceaccount.com)."
  }
}

variable "nfe_backend_uri" {
  type        = string
  description = "Public base URL of the apps/nfe App Hosting backend (e.g. https://nfe-veste.web.app). The reconcile endpoint output is derived from it. Stable across redeploys; the deploy script feeds the outputs into the backend's NFE_TASKS_* env."

  validation {
    condition     = can(regex("^https://", var.nfe_backend_uri))
    error_message = "nfe_backend_uri must be an https:// URL."
  }
}
