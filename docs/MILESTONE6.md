# Milestone 6 — Observe & Automate

## How it fits together

```text
push to main ──▶ GitHub Actions (deploy.yml)
                   │  OIDC ─▶ Workload Identity pool ─▶ github-deployer SA
                   ├─ build api + web images, tag = commit SHA
                   ├─ push to Artifact Registry
                   ├─ kubectl set image (DNS-based control plane endpoint)
                   ├─ wait for rollout (readiness probe: GET /api/health)
                   ├─ GET https://chargeops.ddns.net/api/health → version == SHA?
                   └─ on any failure: kubectl rollout undo → verify old version serves

API pods ──JSON lines──▶ Cloud Logging ──▶ log-based metric chargeops_http_5xx_count
                                             ├─▶ dashboard "ChargeOps - Operations"
                                             └─▶ alert policy ─▶ email
GKE system metrics (CPU, memory, restarts) ──▶ same dashboard
```

## Logging

`server/lib/logger.js` writes one JSON object per line. Every API response is
logged with `severity` and an `httpRequest` object (method, path, status,
latency, client IP); 5xx responses are `ERROR`. Successful health probes are
not logged, and query strings are dropped because signed download URLs carry
a token there. Existing `console.*` calls in the API, workers and traffic
simulator are emitted as JSON too.

**Metric definition** (`infra/terraform/monitoring.tf`):

```text
resource.type="k8s_container"
resource.labels.cluster_name="chargeops-gke"
resource.labels.namespace_name="default"
resource.labels.container_name="api"
(httpRequest.status>=500 OR jsonPayload.httpRequest.status>=500)
```

A counter (DELTA, INT64): each matching log entry adds one.

**Alert:** more than 2 HTTP 5xx responses within five minutes → email to the
addresses in `alert_emails`. Closes automatically 30 minutes after the
condition clears.

## One-time setup

Apply Terraform — see `infra/terraform/README.md`. The workflow already
names the Workload Identity provider and the `github-deployer` service account
(`terraform output`); these are identifiers, not credentials, so no key or
secret is stored in GitHub.

## Demo script

**Controlled 5xx.** Sign in as an operations manager, then:

```bash
read -rsp "Ops password: " PW; echo   # typed, not shown on screen
TOKEN=$(curl -s -X POST https://chargeops.ddns.net/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"ops\",\"password\":\"$PW\"}" | jq -r .token)
for i in 1 2 3 4 5; do
  curl -s -X POST https://chargeops.ddns.net/api/ops/fault -H "Authorization: Bearer $TOKEN"; echo
done
```

Logs Explorer → `resource.labels.container_name="api" AND httpRequest.status>=500`
shows the entries. Metrics Explorer → `logging/user/chargeops_http_5xx_count`
shows the count rise (allow 1–2 minutes). The alert email follows.

**Terraform, no drift.** In `infra/terraform`: `terraform plan -refresh=true`.

**Successful deploy.** Push any small commit to `main`; open the run under
**Actions → Deploy**.

**Failed deploy and rollback.** Push a commit that breaks the readiness
check, for example in `server/app.js`:

```js
app.get("/api/health", async (_req, res) => {
  res.status(503).json({ status: "error", error: "deliberately broken for rollback demo" });
});
```

New API pods never become ready, so `kubectl rollout status` times out after
four minutes; the old pods keep serving throughout (two replicas, surge of
one). The workflow then rolls every deployment back and confirms
`/api/health` reports the previous version. Revert the commit afterwards and
push again; that run should succeed.
