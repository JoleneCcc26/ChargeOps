# ── GKE Autopilot cluster ────────────────────────────────────────────────────
# The control plane has no public IP endpoint. kubectl (people and the
# pipeline) reaches it through GKE's DNS-based endpoint, which is reachable
# from anywhere but authorizes every request with Google IAM.
#
# Autopilot manages nodes, node pools and their scaling itself; those
# settings are not declared here.
resource "google_container_cluster" "primary" {
  name        = "chargeops-gke"
  location    = var.region
  description = "ChargeOps Group 13 Kubernetes Autopilot cluster for Milestone 5 orchestration, autoscaling, and HTTPS deployment."

  enable_autopilot    = true
  deletion_protection = true

  network    = "projects/${var.project_id}/global/networks/default"
  subnetwork = "projects/${var.project_id}/regions/${var.region}/subnetworks/default"

  release_channel {
    channel = "REGULAR"
  }

  ip_allocation_policy {
    cluster_ipv4_cidr_block  = "10.3.128.0/17"
    services_ipv4_cidr_block = "34.118.224.0/20"
  }

  private_cluster_config {
    enable_private_endpoint = true
  }

  master_authorized_networks_config {
    gcp_public_cidrs_access_enabled = false
  }

  control_plane_endpoints_config {
    dns_endpoint_config {
      allow_external_traffic = true
    }
  }

  lifecycle {
    prevent_destroy = true
    # Set by Autopilot or by GKE upgrades, not by us; declaring them would
    # only make the plan fight the platform.
    ignore_changes = [
      ip_allocation_policy,
      private_cluster_config[0].enable_private_nodes,
      node_config,
      node_pool_auto_config,
      cluster_autoscaling,
      min_master_version,
      enable_tpu,
      resource_labels,
    ]
  }
}
