variable "project_id" {
  type    = string
  default = "chargeops-group13"
}

variable "project_number" {
  type    = string
  default = "630804012367"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  type    = string
  default = "us-central1-a"
}

variable "billing_account_id" {
  description = "Billing account the $50 budget belongs to (XXXXXX-XXXXXX-XXXXXX)."
  type        = string
}

variable "team_ip_ranges" {
  description = "Team members' public IPs (/32) allowed to reach the stopped Milestone 2 VM. Kept in terraform.tfvars, not in the repository."
  type        = list(string)
}

variable "alert_emails" {
  description = "Addresses that receive the 5xx alert."
  type        = list(string)
}

variable "alert_5xx_threshold" {
  description = "Alert when more than this many 5xx responses are logged within one minute."
  type        = number
  default     = 2
}

variable "github_repository" {
  description = "Only workflows from this repository may deploy."
  type        = string
  default     = "JoleneCcc26/ChargeOps"
}

variable "psa_range_name" {
  description = "Private Service Access range Cloud SQL's private IP (10.117.0.3) comes from."
  type        = string
  default     = "google-managed-services-default"
}

variable "psa_range_address" {
  type    = string
  default = "10.117.0.0"
}

variable "psa_range_prefix_length" {
  type    = number
  default = 16
}

variable "app_hostname" {
  type    = string
  default = "chargeops.ddns.net"
}
