# ChargeOps — architecture

Milestone 1 runs entirely on one laptop. Every component is chosen so that
migrating it in Milestone 2 means replacing **one adapter file**, not rewriting
the application.

---

## The shape of it

```
                        ┌──────────────────────────────┐
  Ops manager  ────────▶│  React 18 + Vite + Tailwind  │
  Field tech            │  Recharts · Leaflet          │
                        └───────────────┬──────────────┘
                                        │  /api/*
                        ┌───────────────▼──────────────┐
                        │  Express (server/)           │
                        │  validate · store · enqueue  │
                        │  never does slow work        │
                        └──┬─────────┬──────────────┬──┘
                           │         │              │
            ┌──────────────▼──┐  ┌───▼──────────┐  ┌▼──────────────┐
            │  MySQL 9        │  │ Object store │  │ Job queue     │
            │  relational     │  │ (disk → S3)  │  │ (MySQL → SQS) │
            │  + metadata     │  │ photos, PDFs │  │               │
            └─────────────────┘  └───┬──────────┘  └───┬───────────┘
                     ▲               │                 │ SKIP LOCKED
                     │               │                 │
                     │           ┌───▼─────────────────▼───────────┐
                     └───────────┤  Worker pool (1–8 processes)    │
                                 │  billing · files · telemetry    │
                                 └───────────────┬─────────────────┘
                                                 │ backlog metric
                                 ┌───────────────▼─────────────────┐
                                 │  Supervisor (autoscaler)        │
                                 │  target ≈ 25 backlog / worker   │
                                 └─────────────────────────────────┘
```

---

## The three technical dimensions

### 1. Relational data needs

The 11-table model from the database project, unchanged: `company`, `user`,
`membership`, `technician`, `station`, `wallet`, `subscription`, `charger`,
`charging_session`, `payment`, `maintenance_log`. Foreign keys, `CHECK`
constraints and the data-integrity triggers all stay.

Added for the cloud project: `job_queue`, `attachment`, `invoice`,
`charger_telemetry`, `worker_node`, `audit_log`, plus `Station_Lat` / `Station_Lng` on
`station`.

A read-through cache (`server/adapters/cache.js`) sits in front of the expensive
dashboard aggregates, with a TTL chosen per endpoint — 10 s for charger
availability, 60 s for revenue by city — and explicit invalidation from every
write path that makes a cached value wrong.

**Cloud:** Amazon RDS for MySQL with a read replica; ElastiCache for Redis.

### 2. Unstructured file processing

Both directions:

**Ingest.** A technician uploads a fault photo and a service report. The bytes
go to object storage; a worker then reads the JPEG header for dimensions, the
EXIF block for capture time and GPS, and the PDF's compressed content streams
for text. The text goes through a weighted keyword classifier that produces a
fault category, a severity, a vendor error code and part numbers. The GPS fix is
matched against station coordinates. All of it lands in `attachment` as
queryable columns, and a maintenance ticket is opened or updated.

**Generate.** Billing atomically creates a separate `invoice.generate` job.
That job renders the PDF, writes it to object storage and upserts the key in
`invoice`. PDF retries can therefore never replay a wallet debit.

The file bytes never enter MySQL. The browser reaches them through a
time-limited HMAC-signed URL — the local stand-in for an S3 presigned URL.

All parsing is hand-written against Node built-ins (`Buffer`, `zlib`), so there
are no native dependencies and no model downloads. `npm run selftest` covers it.

**Cloud:** S3 + presigned URLs; Rekognition for image labels; Textract for real
OCR (which our parser deliberately cannot do — a scan contains no text objects,
only a picture of text); Comprehend or Bedrock for classification.

### 3. Asynchronous processing and traffic spikes

Charging demand is spiky by nature: commuter peaks, holiday travel, a fleet-wide
reconnect after a network blip.

Three queues, all behind one adapter:

| Queue | Producer | Worker does |
|---|---|---|
| `telemetry` | `POST /api/telemetry` | batches ~50 heartbeats into one multi-row `INSERT`, collapses to one `UPDATE` per charger |
| `billing` | `POST /api/sessions/:id/stop` | charge/payment transaction, followed by an independently retryable PDF invoice job |
| `files` | `POST /api/attachments` | EXIF / text extraction, classification, ticketing |

Every one of those endpoints returns `202 Accepted` after doing only O(1) work,
so API latency does not depend on arrival rate.

The queue is the `job_queue` table, claimed with
`SELECT … FOR UPDATE SKIP LOCKED`. That gives real queue semantics — no double
delivery, no worker blocking another, visibility timeouts, retry with
exponential backoff, and a dead-letter state after three failed attempts.

**Honest limitation:** running the queue inside MySQL adds polling load to the
database we are trying to protect. It is fine at our scale and it demos real
semantics with zero infrastructure — and it is exactly why the cloud version
moves to SQS, a separately scaled service.

**Cloud:** SQS with a DLQ; Lambda or ECS for the workers; CloudWatch alarm plus
a scaling policy in place of `supervisor.js`.

---

## Migration map

| Layer | Milestone 1 (local) | Milestone 2 (AWS) | Dimension |
|---|---|---|---|
| Front end | React 18 + Vite + Tailwind | S3 static site + CloudFront | — |
| Application | Node.js + Express | ECS Fargate behind an ALB | — |
| Relational store | MySQL 9 (local service) | RDS for MySQL + read replica | Relational |
| Object storage | Local disk, S3-shaped adapter | Amazon S3 | Files |
| Message queue | MySQL `job_queue` (SKIP LOCKED) | Amazon SQS + DLQ | Async |
| Workers | Forked Node processes | Lambda or ECS service | Async |
| Autoscaling | `supervisor.js` backlog policy | CloudWatch alarm + scaling policy | Async |
| Cache | In-process TTL map | ElastiCache for Redis | Relational |
| Image analysis | JPEG header + EXIF parser | Rekognition | Files |
| Text extraction | zlib PDF stream parser | Textract | Files |
| Classification | Weighted keyword classifier | Comprehend / Bedrock | Files |
| Signed downloads | HMAC-signed `/api/files` URL | S3 presigned URL | Files |
| Authentication | Local HMAC bearer token + RBAC | Cognito / OIDC | Security |

This table is also served live at `GET /api/ops/architecture` and rendered at
the bottom of the Cloud ops page, so the slide and the running app cannot drift
apart.

---

## Measured results

Run `npm run loadtest` and `npm run loadtest:sync` immediately before the final
demo and record the p50, p95, peak backlog, peak workers and drain time produced
by that machine. Historical values were removed because authentication,
pagination and the split invoice job changed the workload; checked-in benchmark
numbers must not be presented as current measurements.

---

## The change we are proudest of

The database project computed a charging bill inside
`trg_charging_session_after_update`. It worked, and for a database course it was
the right answer. For a cloud course it is the wrong one:

1. **It cannot scale independently.** Billing ran inside `mysqld`, the hardest
   tier to scale out. Five hundred sessions ending at once could only be
   absorbed by buying a bigger database.
2. **It cannot be retried.** A failed wallet debit rolled back the session
   update too — the session "un-ended". No backoff, no dead-letter queue.
3. **It cannot be observed.** No per-step metrics, no logs. You cannot answer
   "what is billing's p95?" from a trigger.
4. **It blocks the user.** "Stop charging" waited for invoice-worthy work.
5. **It cannot leave the database.** No PDF, no object storage, no email.

Now: the endpoint ends the session and enqueues in one transaction, then returns
`202`. A billing worker charges exactly once and atomically enqueues a separate
invoice job. Both jobs have retries, backoff and a DLQ.

Data-integrity triggers stay exactly where they were. **Triggers guard the shape
of the data; workers run the business.**

See `server/sql/02_move_billing_out_of_triggers.sql` for the full before/after.

---

## Where things live

```
server/
  adapters/          the three migration seams — swap these, nothing else
    queue.js           SQS-shaped API over the job_queue table
    storage.js         S3-shaped API over local disk, incl. signed URLs
    cache.js           Redis-shaped API over an in-process TTL map
  lib/
    extract.js         EXIF / PDF / classification / haversine
    exif-writer.js     builds EXIF for the sample photos
    invoice.js         PDF invoice rendering
  routes/            HTTP layer — validates, stores, enqueues, returns 202
  workers/
    supervisor.js      the autoscaler
    worker.js          one worker process
    handlers/          billing.js · fileProcess.js · telemetry.js
  sql/               00 base schema · 00 base data · 01 cloud schema
                     02 trigger migration · 03 reporting package
scripts/
  setup-db.mjs       one command to build the whole database
  make-samples.mjs   generate demo photos (real EXIF GPS) and reports
  loadtest.mjs       the traffic spike, with a --sync control group
  selftest.mjs       extraction tests, no database required
src/pages/
  Uploads.tsx        technician intake — the file dimension
  CloudOps.tsx       live queue / worker / throughput — the async dimension
```
