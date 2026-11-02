# Resources that existed before Terraform. The first `terraform apply` adopts
# them into state without changing them; afterwards these blocks are inert.
# (IAM members and API enablement need no import: creating a grant or enabling
# an API that already exists changes nothing.)

import {
  to = google_container_cluster.primary
  id = "projects/${var.project_id}/locations/${var.region}/clusters/chargeops-gke"
}

import {
  to = google_compute_global_address.private_services
  id = "projects/${var.project_id}/global/addresses/${var.psa_range_name}"
}

import {
  to = google_service_networking_connection.private_services
  id = "projects/${var.project_id}/global/networks/default:servicenetworking.googleapis.com"
}

import {
  to = google_sql_database_instance.db
  id = "projects/${var.project_id}/instances/chargeops-db"
}

import {
  to = google_sql_database.ev
  id = "projects/${var.project_id}/instances/chargeops-db/databases/ev"
}

import {
  to = google_storage_bucket.uploads
  id = "${var.project_id}-uploads"
}

import {
  for_each = local.secrets
  to       = google_secret_manager_secret.app[each.value]
  id       = "projects/${var.project_id}/secrets/${each.value}"
}

import {
  to = google_artifact_registry_repository.images
  id = "projects/${var.project_id}/locations/${var.region}/repositories/chargeops"
}

import {
  to = google_compute_global_address.ingress
  id = "projects/${var.project_id}/global/addresses/chargeops-ingress-ip"
}

import {
  to = google_compute_firewall.allow_iap_ssh
  id = "projects/${var.project_id}/global/firewalls/chargeops-allow-iap-ssh"
}

import {
  to = google_compute_firewall.allow_team
  id = "projects/${var.project_id}/global/firewalls/chargeops-allow-team"
}

import {
  to = google_billing_budget.guardrail
  id = "billingAccounts/${var.billing_account_id}/budgets/ab733ff8-10fb-4db3-8482-4bdd44e81e77"
}
