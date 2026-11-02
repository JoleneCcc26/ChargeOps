# ── Log-based metric: HTTP 5xx responses from the API ───────────────────────
# The API writes one JSON log line per response (server/lib/logger.js) with an
# `httpRequest` object. GKE's logging agent promotes that object to the log
# entry's own httpRequest field; the jsonPayload path is matched as well so
# the count does not depend on that promotion.
resource "google_logging_metric" "http_5xx" {
  name        = "chargeops_http_5xx_count"
  description = "HTTP responses with status 500-599 returned by the ChargeOps API."

  filter = <<-EOT
    resource.type="k8s_container"
    resource.labels.cluster_name="chargeops-gke"
    resource.labels.namespace_name="default"
    resource.labels.container_name="api"
    (httpRequest.status>=500 OR jsonPayload.httpRequest.status>=500)
  EOT

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "ChargeOps API HTTP 5xx responses"
  }
}

locals {
  http_5xx_metric = "logging.googleapis.com/user/${google_logging_metric.http_5xx.name}"
  k8s_filter      = "resource.type=\"k8s_container\" AND resource.label.\"cluster_name\"=\"chargeops-gke\" AND resource.label.\"namespace_name\"=\"default\""
}

# ── Where alerts go ──────────────────────────────────────────────────────────
resource "google_monitoring_notification_channel" "email" {
  for_each     = toset(var.alert_emails)
  display_name = "ChargeOps alerts - ${each.value}"
  type         = "email"
  labels = {
    email_address = each.value
  }
}

# ── Alert: API is returning 5xx ──────────────────────────────────────────────
resource "google_monitoring_alert_policy" "http_5xx" {
  display_name = "ChargeOps API - HTTP 5xx errors"
  combiner     = "OR"

  conditions {
    display_name = "More than ${var.alert_5xx_threshold} HTTP 5xx responses in one minute"

    condition_threshold {
      filter          = "resource.type=\"k8s_container\" AND metric.type=\"${local.http_5xx_metric}\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.alert_5xx_threshold
      duration        = "0s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "1800s"
  }

  notification_channels = [for c in google_monitoring_notification_channel.email : c.id]

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      The ChargeOps API returned more than ${var.alert_5xx_threshold} HTTP 5xx responses within one minute.

      Find them in Logs Explorer with:
      `resource.labels.container_name="api" AND httpRequest.status>=500`
    EOT
  }
}

# ── Dashboard: errors and resource usage ─────────────────────────────────────
resource "google_monitoring_dashboard" "ops" {
  dashboard_json = jsonencode({
    displayName = "ChargeOps - Operations"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          xPos = 0, yPos = 0, width = 4, height = 4
          widget = {
            title = "HTTP 5xx responses (last hour)"
            scorecard = {
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"${local.http_5xx_metric}\" AND resource.type=\"k8s_container\""
                  aggregation = {
                    alignmentPeriod    = "3600s"
                    perSeriesAligner   = "ALIGN_SUM"
                    crossSeriesReducer = "REDUCE_SUM"
                  }
                }
              }
              sparkChartView = { sparkChartType = "SPARK_BAR" }
            }
          }
        },
        {
          xPos = 4, yPos = 0, width = 8, height = 4
          widget = {
            title = "HTTP 5xx responses per minute"
            xyChart = {
              dataSets = [{
                plotType = "STACKED_BAR"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"${local.http_5xx_metric}\" AND resource.type=\"k8s_container\""
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_SUM"
                      crossSeriesReducer = "REDUCE_SUM"
                    }
                  }
                }
              }]
              thresholds = [{ value = var.alert_5xx_threshold, label = "Alert threshold" }]
              yAxis      = { label = "responses", scale = "LINEAR" }
            }
          }
        },
        {
          xPos = 0, yPos = 4, width = 6, height = 4
          widget = {
            title = "CPU usage by container (cores)"
            xyChart = {
              dataSets = [{
                plotType = "LINE"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"kubernetes.io/container/cpu/core_usage_time\" AND ${local.k8s_filter}"
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["resource.label.\"container_name\""]
                    }
                  }
                }
              }]
              yAxis = { label = "cores", scale = "LINEAR" }
            }
          }
        },
        {
          xPos = 6, yPos = 4, width = 6, height = 4
          widget = {
            title = "Memory usage by container"
            xyChart = {
              dataSets = [{
                plotType = "LINE"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"kubernetes.io/container/memory/used_bytes\" AND metric.label.\"memory_type\"=\"non-evictable\" AND ${local.k8s_filter}"
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_MEAN"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["resource.label.\"container_name\""]
                    }
                  }
                }
              }]
              yAxis = { label = "bytes", scale = "LINEAR" }
            }
          }
        },
        {
          xPos = 0, yPos = 8, width = 6, height = 4
          widget = {
            title = "Container restarts"
            xyChart = {
              dataSets = [{
                plotType = "STACKED_BAR"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"kubernetes.io/container/restart_count\" AND ${local.k8s_filter}"
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_DELTA"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["resource.label.\"container_name\""]
                    }
                  }
                }
              }]
            }
          }
        },
        {
          xPos = 6, yPos = 8, width = 6, height = 4
          widget = {
            title = "Alert: HTTP 5xx errors"
            alertChart = {
              name = google_monitoring_alert_policy.http_5xx.name
            }
          }
        },
      ]
    }
  })
}
