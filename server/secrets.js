// server/secrets.js - fetch secrets from Google Secret Manager at boot.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED, AND WHY
// ─────────────────────────────────────────────────────────────────────────────
// Until Milestone 3 the database password and the two signing secrets arrived
// as environment variables, which meant a .env file sat next to the compose
// file on the VM: readable by anyone with a shell on that machine, copied into
// every backup of it, and impossible to rotate without editing the file and
// restarting by hand.
//
// Now the running container is given names, not values. At start-up it asks
// Secret Manager for the current version of each secret, using the VM's own
// service account through Application Default Credentials. Rotating a secret is
// adding a new version and restarting the container; nothing on disk changes,
// and a leaked disk image contains no credentials at all.
//
// Set SECRETS_PROVIDER=gcp to turn this on. Locally it stays off, so
// `docker compose up` still works from .env with no cloud access at all.
const PROVIDER = (process.env.SECRETS_PROVIDER || "env").toLowerCase();
const PROJECT = process.env.SECRETS_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;

/** Environment variable -> the secret that holds its value. */
const SECRETS = {
  DB_PASS: "chargeops-db-password",
  AUTH_TOKEN_SECRET: "chargeops-auth-token-secret",
  STORAGE_SIGNING_SECRET: "chargeops-storage-signing-secret",
  AUTH_OPS_PASSWORD: "chargeops-demo-password",
  AUTH_TECH_PASSWORD: "chargeops-demo-password",
  AUTH_FINANCE_PASSWORD: "chargeops-demo-password",
  AUTH_HOST_PASSWORD: "chargeops-demo-password",
  AUTH_VIEWER_PASSWORD: "chargeops-demo-password",
  DEMO_PASSWORD: "chargeops-demo-password",
};

/**
 * Read a secret from the environment.
 *
 * In production there is no fallback: if Secret Manager did not supply the
 * value, the process refuses to start. A default that silently applies in
 * production is worse than a crash - it is a password that looks configured,
 * appears in no screenshot, and is identical in every deployment that ever
 * copied this repository.
 *
 * Locally the development value is used, so `docker compose up` still works
 * with no cloud account at all.
 */
export function requiredSecret(name, developmentValue) {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `${name} is not set. In production it must come from Secret Manager ` +
        `(SECRETS_PROVIDER=gcp); there is no built-in default.`
    );
  }
  return developmentValue;
}

export async function loadSecrets() {
  if (PROVIDER !== "gcp") return { provider: PROVIDER, loaded: [] };
  if (!PROJECT) throw new Error("SECRETS_PROVIDER=gcp but SECRETS_PROJECT is not set");

  // Imported here rather than at the top so local development never needs the
  // dependency resolved, let alone credentials.
  const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
  const client = new SecretManagerServiceClient();

  // One fetch per distinct secret, even though five environment variables share
  // the demo password.
  const wanted = [...new Set(Object.values(SECRETS))];
  const values = new Map();
  await Promise.all(
    wanted.map(async (name) => {
      const [version] = await client.accessSecretVersion({
        name: `projects/${PROJECT}/secrets/${name}/versions/latest`,
      });
      values.set(name, version.payload.data.toString("utf8"));
    })
  );

  const loaded = [];
  for (const [envVar, secretName] of Object.entries(SECRETS)) {
    const value = values.get(secretName);
    if (value === undefined) continue;
    process.env[envVar] = value;
    loaded.push(envVar);
  }
  return { provider: "gcp", project: PROJECT, secrets: wanted, loaded };
}
