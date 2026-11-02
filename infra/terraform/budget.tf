# ── $50 monthly budget, alerts at 20% / 50% / 100% ($10 / $25 / $50) ──────────
# Covers the whole billing account and counts actual spend before free-trial
# credits. Emails go to the billing account's administrators.
resource "google_billing_budget" "guardrail" {
  billing_account = var.billing_account_id
  display_name    = "ChargeOps guardrail"

  amount {
    specified_amount {
      currency_code = "USD"
      units         = "50"
    }
  }

  budget_filter {
    calendar_period        = "MONTH"
    credit_types_treatment = "EXCLUDE_ALL_CREDITS"
  }

  threshold_rules {
    threshold_percent = 0.2
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }
}
