# ── Cloud SQL: private IP only ───────────────────────────────────────────────

# The range Google allocated for Private Service Access when the instance was
# created with "automatically assigned IP range", and the peering that uses it.
resource "google_compute_global_address" "private_services" {
  name          = var.psa_range_name
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  address       = var.psa_range_address
  prefix_length = var.psa_range_prefix_length
  network       = data.google_compute_network.default.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = data.google_compute_network.default.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}

resource "google_sql_database_instance" "db" {
  name                = "chargeops-db"
  database_version    = "MYSQL_8_0"
  region              = var.region
  deletion_protection = true

  settings {
    tier              = "db-f1-micro"
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    disk_size         = 10
    disk_autoresize   = false

    location_preference {
      zone = var.zone
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = data.google_compute_network.default.id
    }

    backup_configuration {
      enabled            = false
      binary_log_enabled = false
    }
  }

  depends_on = [google_service_networking_connection.private_services]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_sql_database" "ev" {
  name     = "ev"
  instance = google_sql_database_instance.db.name
}

# ── Cloud Storage: uploads, reached through IAM identity ────────────────────

resource "google_storage_bucket" "uploads" {
  name                        = "${var.project_id}-uploads"
  location                    = "US-CENTRAL1"
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_storage_bucket_iam_member" "uploads_object_admin" {
  for_each = toset([local.ksa_principal, local.compute_sa])
  bucket   = google_storage_bucket.uploads.name
  role     = "roles/storage.objectAdmin"
  member   = each.value
}

resource "google_storage_bucket_iam_member" "uploads_ksa_bucket_reader" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.legacyBucketReader"
  member = local.ksa_principal
}

# ── Secret Manager: containers hold names, never values ─────────────────────
# Terraform manages the secrets and who may read them. The values are added
# with `gcloud secrets versions add` and never pass through Terraform, so they
# never reach the state file.

locals {
  secrets = toset([
    "chargeops-auth-token-secret",
    "chargeops-db-password",
    "chargeops-db-root-password",
    "chargeops-demo-password",
    "chargeops-storage-signing-secret",
  ])

  # The root password is for administrators only; no workload reads it.
  app_secrets = setsubtract(local.secrets, ["chargeops-db-root-password"])

  secret_readers = {
    for pair in setproduct(local.app_secrets, [local.ksa_principal, local.compute_sa]) :
    "${pair[0]}|${pair[1]}" => { secret = pair[0], member = pair[1] }
  }
}

resource "google_secret_manager_secret" "app" {
  for_each  = local.secrets
  secret_id = each.value

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "readers" {
  for_each  = local.secret_readers
  secret_id = google_secret_manager_secret.app[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value.member
}
