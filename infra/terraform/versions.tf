terraform {
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.20"
    }
  }

  # State lives in a versioned bucket, never in the repository. The bucket is
  # created once by hand (see README.md) because Terraform cannot store its
  # state in a bucket it has not created yet.
  backend "gcs" {
    bucket = "chargeops-group13-tfstate"
    prefix = "terraform/state"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  # The Billing Budget and Monitoring APIs bill quota to a project when called
  # with user credentials; without this they reject the request.
  user_project_override = true
  billing_project       = var.project_id
}
