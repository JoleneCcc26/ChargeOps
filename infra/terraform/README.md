# ChargeOps infrastructure (Terraform)

Everything the application runs on in project `chargeops-group13`, plus the
Milestone 6 monitoring and the identity the deployment pipeline uses.

| File | What it manages |
|---|---|
| `gke.tf` | GKE Autopilot cluster `chargeops-gke` (private control plane, DNS endpoint) |
| `data.tf` | Cloud SQL `chargeops-db` (private IP only) and its peering range, database `ev`; bucket `chargeops-group13-uploads` and its IAM; the five Secret Manager secrets and who may read them |
| `network.tf` | Ingress static IP, the two `chargeops-*` firewall rules, Artifact Registry repository |
| `monitoring.tf` | 5xx log-based metric, dashboard, email notification channel, alert policy |
| `budget.tf` | $50 monthly budget with 20 / 50 / 100 % alerts |
| `cicd.tf` | Workload Identity pool for GitHub Actions and the `github-deployer` service account |
| `project.tf` | Enabled APIs |
| `imports.tf` | Adopts the resources created by hand in Milestones 2–5 |

## Not managed by Terraform

| Resource | Why |
|---|---|
| Kubernetes objects (`k8s/*.yaml`: deployments, services, ingress, HPA, PDB, managed certificate) | Applied with `kubectl`; image versions are rolled out by the pipeline. The HTTPS load balancer, its certificate and the `gke-*` / `k8s-fw-*` firewall rules are created by GKE from these manifests. |
| Secret **values** | Added with `gcloud secrets versions add` so they never enter Terraform state. Terraform manages the secrets and their access only. |
| Cloud SQL users and passwords | The password lives in Secret Manager; managing it here would put it in state. |
| VM `chargeops-vm` (stopped) | The Milestone 2–4 host, kept stopped as a fallback. Not part of the running application. Its firewall rules are managed. |
| `default` VPC network and subnet | Created automatically with the project; read as a data source. |
| Project IAM for people, and the Compute Engine default service account's Editor role | Team access, not application infrastructure. |
| DNS name `chargeops.ddns.net` | Hosted by No-IP, outside Google Cloud. |
| State bucket `chargeops-group13-tfstate` | Must exist before Terraform can use it (bootstrap). |

## First run

Run from Cloud Shell (Terraform is pre-installed), signed in as a project
Owner who is also a billing account administrator (needed for the budget).

```bash
# 1. One-time: the state bucket (versioned, private).
gcloud storage buckets create gs://chargeops-group13-tfstate \
  --location=us-central1 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://chargeops-group13-tfstate --versioning

# 2. Variables.
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # then edit it

# 3. Adopt the existing resources and create the new ones.
terraform init
terraform plan -out tfplan
terraform apply tfplan
```

Before `apply`, read the plan: imported resources should show **import**
with no `~ update` or `-/+ replace`, and the only creations should be the
monitoring resources, the GitHub identity resources, IAM members and API
enablements. If an imported resource shows a change, adjust its block to match
what exists rather than applying.


## Proving no drift (demo)

```bash
terraform plan -refresh=true
# No changes. Your infrastructure matches the configuration.
```
