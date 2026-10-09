// server/adapters/storage.gcs.js - the same six-function object store, backed by
// Google Cloud Storage instead of the local disk.
//
// ─────────────────────────────────────────────────────────────────────────────
// NO KEY FILE
// ─────────────────────────────────────────────────────────────────────────────
// There is no service-account JSON anywhere in this image. The client below
// authenticates with Application Default Credentials, which on a Compute Engine
// VM means: ask the metadata server for a token belonging to the VM's own
// service account. The VM is allowed to write this bucket because of an IAM
// binding on the bucket, not because it is holding a credential we copied in.
//
// A key file would work too, and that is exactly the problem: it would be a
// long-lived secret sitting in a container, surviving snapshots and backups,
// with nothing to rotate it. Tokens from the metadata server expire in an hour
// and are re-fetched automatically.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE DOWNLOAD URLS ARE STILL OURS
// ─────────────────────────────────────────────────────────────────────────────
// GCS can sign its own URLs, but signing from a VM without a key file needs an
// extra IAM round trip (signBlob) and hands the browser a URL that bypasses the
// application entirely. We keep the existing contract instead: the API hands out
// a short-lived HMAC URL that points back at /api/files, and that route streams
// the bytes out of the bucket. The bucket itself stays private - public access
// is prevented at the bucket level - and every download still passes through
// our own authorisation check.
import crypto from "node:crypto";
import { Storage } from "@google-cloud/storage";

export const BUCKET = process.env.STORAGE_BUCKET;

const storage = new Storage();
const bucket = () => storage.bucket(BUCKET);

export async function putObject(key, body, contentType = "application/octet-stream") {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  await bucket().file(key).save(buf, {
    contentType,
    // One request instead of a resumable session: these are invoice PDFs and
    // phone photos, a few megabytes at most.
    resumable: false,
  });
  return {
    bucket: BUCKET,
    key,
    size: buf.length,
    contentType,
    checksumSha256: crypto.createHash("sha256").update(buf).digest("hex"),
  };
}

export async function getObject(key) {
  const file = bucket().file(key);
  const [buf] = await file.download();
  let contentType = "application/octet-stream";
  try {
    const [md] = await file.getMetadata();
    contentType = md.contentType || contentType;
  } catch {
    // Metadata is a nicety; the bytes are what the caller asked for.
  }
  return { body: buf, contentType, size: buf.length };
}

export async function headObject(key) {
  const [md] = await bucket().file(key).getMetadata();
  return {
    size: Number(md.size || 0),
    contentType: md.contentType || "application/octet-stream",
    lastModified: md.updated ? new Date(md.updated) : new Date(),
  };
}

export async function deleteObject(key) {
  await bucket().file(key).delete({ ignoreNotFound: true });
}

export async function listObjects(prefix = "") {
  const [files] = await bucket().getFiles({ prefix });
  return files.map((f) => ({ key: f.name, size: Number(f.metadata?.size || 0) }));
}

export async function storageStats() {
  const objects = await listObjects("");
  return {
    bucket: BUCKET,
    backend: "google-cloud-storage",
    root: `gs://${BUCKET}`,
    objectCount: objects.length,
    totalBytes: objects.reduce((sum, o) => sum + o.size, 0),
  };
}

/**
 * Check the bucket is reachable. We deliberately do NOT create it: the bucket is
 * infrastructure with its own lifecycle, and an application that can create
 * buckets is an application whose service account can create buckets.
 */
export async function ensureBucket() {
  const [exists] = await bucket().exists();
  if (!exists) throw new Error(`bucket gs://${BUCKET} is not reachable by this service account`);
  return `gs://${BUCKET}`;
}
