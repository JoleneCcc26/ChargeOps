// server/adapters/storage.js - object storage adapter (local: disk, cloud: Amazon S3)
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE THIS FILE ENFORCES
// ─────────────────────────────────────────────────────────────────────────────
// File bytes NEVER go into MySQL. Not as BLOB, not as base64 in a TEXT column.
//
// Why not, in one paragraph you can say in the video: a relational database is
// optimised for small rows that are read, joined and updated constantly. Blobs
// are large, immutable and read rarely. Putting them in MySQL blows out the
// buffer pool (so your *real* queries stop being cached), makes every backup
// and every replica-rebuild proportional to your media volume, and gives you no
// CDN in front of the bytes. Object storage is the opposite trade: cheap,
// effectively infinite, HTTP-native, but with no joins and no transactions.
//
// So we split them. Bytes -> object storage. "Where the bytes are, and what we
// learned from them" -> the attachment / invoice tables.
//
// ─────────────────────────────────────────────────────────────────────────────
// LOCAL vs CLOUD
// ─────────────────────────────────────────────────────────────────────────────
// The API below is deliberately the S3 API, minus the parts we do not use:
//
//     putObject(key, body, contentType)   -> s3.PutObjectCommand
//     getObject(key)                      -> s3.GetObjectCommand
//     headObject(key)                     -> s3.HeadObjectCommand
//     deleteObject(key)                   -> s3.DeleteObjectCommand
//     listObjects(prefix)                 -> s3.ListObjectsV2Command
//     getSignedUrl(key, ttl)              -> @aws-sdk/s3-request-presigner
//
// Locally, objects are files under server/.storage/<key>. Milestone 2 swaps the
// body of these six functions for @aws-sdk/client-s3 calls; every caller
// (routes, workers, the React app) is unaffected because the key strings and
// the signed-URL contract do not change.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Local "bucket". In the cloud this becomes process.env.S3_BUCKET. */
export const BUCKET = process.env.STORAGE_BUCKET || "chargeops-local";

const ROOT = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.resolve(__dirname, "..", ".storage");

/**
 * Secret used to sign download URLs. In the cloud, S3 signs with your IAM
 * credentials and this disappears entirely.
 */
const SIGNING_SECRET =
  process.env.STORAGE_SIGNING_SECRET || "chargeops-dev-signing-key-change-me";

// ─────────────────────────────────────────────────────────────────────────────
// Key helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an S3-style key. We use a date prefix (maintenance/2026/08/...) for the
 * same reason S3 users do: it keeps any single "directory" small and makes
 * lifecycle rules ("move anything older than 90 days to Glacier") trivial to
 * express later.
 */
export function buildKey(prefix, originalName) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const ext = path.extname(originalName || "").toLowerCase().slice(0, 10);
  const id = crypto.randomBytes(8).toString("hex");
  return `${prefix}/${yyyy}/${mm}/${id}${ext}`;
}

/**
 * Resolve a key to a path on disk, refusing anything that escapes the bucket.
 *
 * S3 keys are opaque strings, but our local backend turns them into filesystem
 * paths - so a key like "../../server/.env" would be a path-traversal read.
 * We normalise and then assert the result is still inside ROOT.
 */
function keyToPath(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 512) {
    throw new Error("invalid storage key");
  }
  // An object key must land strictly INSIDE the bucket. Resolving to the bucket
  // directory itself is not a valid object, so `allowRoot` stays false here.
  return resolveInsideBucket(key, false);
}

/**
 * A listing PREFIX is different from an object key: "" or "/" legitimately
 * means "the whole bucket", which resolves to the bucket directory itself.
 * Passing that through keyToPath would trip the traversal guard, because
 * `full === ROOT` does not start with `ROOT + separator`.
 */
function prefixToPath(prefix) {
  if (typeof prefix !== "string" || prefix.length > 512) {
    throw new Error("invalid storage prefix");
  }
  return resolveInsideBucket(prefix.replace(/^\/+|\/+$/g, "") || ".", true);
}

function resolveInsideBucket(rel, allowRoot) {
  const full = path.resolve(ROOT, rel);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  const inside = full.startsWith(rootWithSep) || (allowRoot && full === ROOT);
  if (!inside) {
    throw new Error("invalid storage key: escapes bucket root");
  }
  return full;
}

// ─────────────────────────────────────────────────────────────────────────────
// The S3-shaped API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Store bytes under `key`.
 *
 * Returns the checksum too, because the caller always wants it for the
 * attachment row (S3 gives you the same thing back as the object's ETag).
 */
export async function putObject(key, body, contentType = "application/octet-stream") {
  const full = keyToPath(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  await fs.writeFile(full, buf);

  // Sidecar metadata file. S3 stores content-type as object metadata; on a
  // plain filesystem there is nowhere to put it, so we keep a small .meta.json.
  await fs.writeFile(
    `${full}.meta.json`,
    JSON.stringify({ contentType, size: buf.length, storedAt: new Date().toISOString() }),
    "utf8"
  );

  return {
    bucket: BUCKET,
    key,
    size: buf.length,
    contentType,
    checksumSha256: crypto.createHash("sha256").update(buf).digest("hex"),
  };
}

/** Read bytes back. Throws if the key does not exist. */
export async function getObject(key) {
  const full = keyToPath(key);
  const body = await fs.readFile(full);
  let contentType = "application/octet-stream";
  try {
    const meta = JSON.parse(await fs.readFile(`${full}.meta.json`, "utf8"));
    contentType = meta.contentType || contentType;
  } catch {
    // No sidecar (e.g. a file dropped in by hand) - fall back to the default.
  }
  return { body, contentType, size: body.length };
}

/** Size + content type without transferring the bytes. */
export async function headObject(key) {
  const full = keyToPath(key);
  const stat = await fs.stat(full);
  let contentType = "application/octet-stream";
  try {
    const meta = JSON.parse(await fs.readFile(`${full}.meta.json`, "utf8"));
    contentType = meta.contentType || contentType;
  } catch {
    /* ignore */
  }
  return { size: stat.size, contentType, lastModified: stat.mtime };
}

export async function deleteObject(key) {
  const full = keyToPath(key);
  await fs.rm(full, { force: true });
  await fs.rm(`${full}.meta.json`, { force: true });
}

export async function listObjects(prefix = "") {
  const base = prefixToPath(prefix);
  const out = [];
  async function walk(dir, rel) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.endsWith(".meta.json")) continue;
      const abs = path.join(dir, e.name);
      const key = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, key);
      else out.push({ key, size: (await fs.stat(abs)).size });
    }
  }
  await walk(base, prefix.replace(/\/$/, ""));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Presigned URLs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce a time-limited, tamper-proof download URL.
 *
 * This is worth understanding because it is how every real cloud app serves
 * private media. The browser must be able to fetch the file directly, but the
 * bucket is private and the browser has no AWS credentials. So the server -
 * which DOES have credentials, and which has just checked that this user is
 * allowed to see this file - hands out a URL with an expiry and a signature
 * baked into the query string. Anyone holding the URL can fetch the object
 * until it expires; nobody can forge one or edit the key without invalidating
 * the signature.
 *
 * We reproduce the same contract with an HMAC over "key + expiry". Milestone 2
 * deletes this function and calls @aws-sdk/s3-request-presigner instead - the
 * React app never notices, because it just follows whatever URL it is given.
 */
export function getSignedUrl(key, ttlSeconds = 900) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = signKey(key, expires);
  return `/api/files/${encodeURI(key)}?expires=${expires}&sig=${sig}`;
}

/** Constant-time verification of a signed URL. */
export function verifySignedUrl(key, expires, sig) {
  const exp = Number(expires);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = signKey(key, exp);
  const a = Buffer.from(String(sig || ""));
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so check that first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signKey(key, expires) {
  return crypto
    .createHmac("sha256", SIGNING_SECRET)
    .update(`${key}:${expires}`)
    .digest("hex")
    .slice(0, 32);
}

/** Total bytes + object count, shown on the ops dashboard. */
export async function storageStats() {
  const objects = await listObjects("");
  return {
    bucket: BUCKET,
    backend: "local-disk",
    root: ROOT,
    objectCount: objects.length,
    totalBytes: objects.reduce((sum, o) => sum + o.size, 0),
  };
}

export async function ensureBucket() {
  await fs.mkdir(ROOT, { recursive: true });
  return ROOT;
}
