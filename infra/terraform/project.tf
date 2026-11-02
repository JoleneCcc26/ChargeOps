# APIs the application, the pipeline and the monitoring depend on. Enabling an
# API that is already on is a no-op, so these need no import.
locals {
  services = [
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "container.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",
  ]

  # The identity the API, worker and traffic pods run as: Kubernetes service
  # account default/chargeops-ksa, granted access directly through GKE
  # Workload Identity (no Google service account or key file in between).
  ksa_principal = "principal://iam.googleapis.com/projects/${var.project_number}/locations/global/workloadIdentityPools/${var.project_id}.svc.id.goog/subject/ns/default/sa/chargeops-ksa"

  # The Compute Engine default service account. The stopped Milestone 2-4 VM
  # ran as it, and it keeps its grants so that VM still works if started.
  compute_sa = "serviceAccount:${var.project_number}-compute@developer.gserviceaccount.com"
}

resource "google_project_service" "enabled" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}

data "google_compute_network" "default" {
  name = "default"
}
