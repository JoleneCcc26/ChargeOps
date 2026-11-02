# ── Ingress ──────────────────────────────────────────────────────────────────
# Reserved global IP the GKE Ingress (HTTPS load balancer) answers on. The
# load balancer itself, its certificate and its backends are created by GKE
# from k8s/ingress.yaml and k8s/managed-certificate.yaml.
resource "google_compute_global_address" "ingress" {
  name = "chargeops-ingress-ip"
}

# ── Firewall for the stopped Milestone 2-4 VM ────────────────────────────────
# Scoped to Google's IAP range and the team's own /32s; never 0.0.0.0/0. The
# gke-* and k8s-fw-* rules are created and owned by GKE and are not managed
# here.
resource "google_compute_firewall" "allow_iap_ssh" {
  name          = "chargeops-allow-iap-ssh"
  description   = "SSH-in-browser / IAP tunnel for the team (authenticated by Google IAM)"
  network       = data.google_compute_network.default.name
  direction     = "INGRESS"
  priority      = 1000
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["chargeops-web"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_firewall" "allow_team" {
  name          = "chargeops-allow-team"
  description   = "ChargeOps: web and SSH from team IPs only"
  network       = data.google_compute_network.default.name
  direction     = "INGRESS"
  priority      = 1000
  source_ranges = var.team_ip_ranges
  target_tags   = ["chargeops-web"]

  allow {
    protocol = "tcp"
    ports    = ["22", "80"]
  }
}

# ── Container images ─────────────────────────────────────────────────────────
resource "google_artifact_registry_repository" "images" {
  repository_id = "chargeops"
  description   = "ChargeOps container images (Milestone 3)"
  location      = var.region
  format        = "DOCKER"
}
