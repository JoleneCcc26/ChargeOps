output "workload_identity_provider" {
  description = "Value for the GCP_WORKLOAD_IDENTITY_PROVIDER repository variable."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_service_account" {
  description = "Value for the GCP_DEPLOYER_SERVICE_ACCOUNT repository variable."
  value       = google_service_account.deployer.email
}

output "http_5xx_metric" {
  value = local.http_5xx_metric
}

output "dashboard_url" {
  value = "https://console.cloud.google.com/monitoring/dashboards/builder/${element(split("/", google_monitoring_dashboard.ops.id), 3)}?project=${var.project_id}"
}

output "ingress_ip" {
  value = google_compute_global_address.ingress.address
}
