terraform {
  # Pin a floor that includes the GA App Hosting + Cloud Tasks resources.
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.32.0, < 8.0.0"
    }
  }

  # Remote state in GCS, in the SAME project, with a per-project prefix so a
  # plan/apply can never read or clobber another project's state. Configured
  # out-of-band (no variables allowed in a backend block) via:
  #   terraform init -backend-config=backend.hcl
  # See backend.hcl.example + README.
  backend "gcs" {}
}

# Provider is pinned to ONE project (var.project_id has no default — every
# plan/apply must name it explicitly). This module never creates or mutates
# projects/folders/orgs, so it cannot reach outside the named project.
provider "google" {
  project = var.project_id
  region  = var.region
}
