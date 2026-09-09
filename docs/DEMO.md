# ChargeOps — 10-minute demo runbook

Everything you need for the Milestone 1 video, in the order you should show it.

---

## Before you hit record

Four terminals, or three plus one for the load test.

```bash
npm install
```

```bash
npm run setup:db
```

```bash
npm run seed:demo
```

```bash
npm run dev:all
```

`dev:all` starts three things at once: the Express API on `:4000`, the
autoscaling worker pool, and Vite on `:5173`. Open two browser tabs —
**Field uploads** and **Cloud ops** — and put Cloud ops on the second monitor.

Sign in at `http://localhost:5173/login` with `ops` / `chargeops-demo` for the
full operations-manager demo. The `tech` account is limited to field uploads
and maintenance work, while `viewer` is read-only.

Reset between takes: hit **Reset counters** on the Cloud ops page. It purges
finished jobs and clears the charts so the next run starts from zero.

**Run this before you record, and again after any load test:**

```bash
npm run seed:activity
```

A load test writes thousands of sessions into whichever clock hour it ran in and
closes every one of them. Left alone, that means the Chargers page shows zero
chargers in use and every chart over time shows two spikes and nothing else — a
network that looks switched off. `seed:activity` spreads that bulk history across
the past three weeks on a realistic daily curve and puts about eighteen percent
of the fleet mid-session, so the demo opens on a network that is visibly running.

One small thing that makes the demo look better: **click through Dashboard once
before you record.** The cache hit-rate tile reads 0% until something has
actually queried the cached endpoints, and a 0% tile invites a question you
don't want to spend demo time on.

Sanity check, no database needed:

```bash
npm run selftest
```

---

## The 10 minutes

### 0:00 – 1:00 · Domain and problem *(camera on the speaker)*

> "Public EV charging has a reliability problem. A meaningful share of chargers
> are broken at any given time, and the operator usually finds out because a
> driver complained — not because the network told them. Every hour a charger is
> down is lost revenue and a customer who may not come back.
>
> ChargeOps is the internal operations platform for a charging network. Our user
> is the **network operations manager** — the person responsible for uptime
> across hundreds of sites — and the **field technician** they dispatch."

Say plainly what carried over and what is new: the relational model and the
admin dashboard come from our database course project; everything about how the
system handles files, load and scale is new for this course.

> Check the current industry uptime figure before recording and cite the source
> on the slide rather than quoting a number from memory.

### 1:00 – 3:00 · The core user flow *(share screen: Field uploads)*

This is the "what does someone actually do with this app" section.

1. Pick a station and a charger from the dropdowns.
2. Drag in `samples/02-cable-damage-photo.jpg` **and**
   `samples/02-cable-damage-report.pdf`.
3. Point at the green line: **`202 Accepted`**, immediately.

> "Note what just happened. The API took the files, put them in object storage,
> and returned. It has not looked at them yet. The technician's phone is already
> free."

4. The cards appear as **queued**. Wait the second or two for them to flip.
5. Now walk the derived fields:

   - **`critical` / `cable` / `E-1180`** — pulled out of the report's prose. No
     one typed those into a form.
   - **GPS matched \<station\> (\~240 m)** — the photo's EXIF GPS tag, matched
     against station coordinates. The photo reported where it came from.
   - **ticket #NN** — a maintenance ticket was opened automatically, assigned to
     a technician, and because the severity is critical, the charger was taken
     out of service.

6. Click a card to open the drawer. Show the raw `Extracted` JSON and say:

> "Left column: unstructured bytes. Right column: rows and columns the manager
> can filter and chart. That round trip is the file-processing dimension."

7. Switch to **Maintenance** and show the ticket that appeared there.

### 3:00 – 6:00 · The traffic spike *(the centrepiece — give it the time)*

Put **Cloud ops** on screen. Steady state: backlog 0, workers 1.

```bash
npm run loadtest
```

Narrate it as it happens:

| What is on screen | What to say |
|---|---|
| Backlog shoots to ~700 | "Six thousand charger heartbeats and eight hundred sessions ending at once — our 6 p.m. peak." |
| Worker line steps 1 → 4 → 8 | "The supervisor is watching backlog per worker and forking processes. That is the same control loop an ECS service or a Lambda concurrency scaler runs — read a metric, compare to a target, add capacity." |
| Throughput chart climbs | "That is the capacity the autoscaler just bought." |
| **Terminal p50/p95 latency** | "And here is the number that matters: p50 of 12 milliseconds, with 700 jobs of real work still outstanding. The API never billed anything — it validated and enqueued." |
| Backlog drains to 0, workers step back to 1 | "Scale-up is instant, scale-down waits out a cooldown. Killing workers the moment a queue empties means you pay the startup cost again on the next burst." |

Then the control group — this is what makes the argument land:

```bash
npm run loadtest:sync
```

When you are finished load testing, restore the operating picture before you
record the rest of the demo:

```bash
npm run seed:activity
```

> "Same work, same machine, same database — but billed inline inside the
> request, the way our trigger did it last semester. Watch the p50."

Read the p50, p95, peak backlog, throughput, and drain time from the two current
runs. Do not reuse old laptop measurements: the numbers vary with the database,
worker count, and host. The defensible claim is the behavior visible in your
recording — the asynchronous API acknowledges work quickly while the queue
absorbs the burst and workers drain it independently.

### 6:00 – 8:00 · Architecture *(scroll down on Cloud ops)*

The **Milestone 2 migration map** is rendered live at the bottom of the page,
served from `/api/ops/architecture` — the same table that is on slide 2.

Cover the three dimensions explicitly, because they are 10 of the 50 points:

- **Relational** — 11 tables from the database project, unchanged. RDS in
  Milestone 2. Cache in front of the expensive dashboard aggregates.
- **Unstructured files** — bytes in object storage, metadata and extraction
  results in MySQL. S3 + Rekognition + Textract in Milestone 2.
- **Async / traffic spikes** — the queue, the workers, the autoscaler. SQS +
  Lambda/ECS + CloudWatch scaling in Milestone 2.

Then the one-sentence version of the biggest change:

> "Triggers guard the shape of the data. Workers run the business. We moved
> billing out of a MySQL trigger and into a worker, because a trigger cannot be
> scaled independently, cannot be retried, cannot be observed, and cannot write
> a PDF to object storage."

Have `server/sql/02_move_billing_out_of_triggers.sql` open in an editor tab —
the before/after is written out in the file header.

### 8:00 – 9:00 · Resilience *(optional but it is cheap and it impresses)*

While workers are running, kill one: `Ctrl-C` in the workers terminal, or end a
`node` process in Task Manager.

- The supervisor replaces it within a second.
- Any job that worker was holding is redelivered after its visibility timeout —
  nothing is lost.
- If a job fails three times it lands in the **dead-letter queue** panel, and
  **Redrive DLQ** puts it back.

> "At-least-once delivery means a job can run twice, so every handler is
> idempotent. The billing worker locks the session row and checks it is still
> `Pending` before it charges anyone — that guard is why a redelivery cannot
> double-bill a customer."

### 9:00 – 10:00 · Close *(camera back on)*

What "done" looks like: same application, same code, running on managed services
— RDS, S3, SQS, Lambda/ECS — with the autoscaler driven by CloudWatch instead of
our supervisor. Say what each teammate owns.

---

## Recording notes

- **Cameras on.** Every presenting member's face must be visible for their part.
  Audio-only over a screen recording is explicitly rejected.
- Record at 1080p and bump the editor/browser font size — terminal text at
  native size is unreadable after compression.
- Zoom the browser to ~110 % so the Cloud ops charts read on a laptop screen.
- Do a dry run of the load test first. The first run of anything is always the
  slow one.

## If something breaks on camera

| Symptom | Fix |
|---|---|
| Cloud ops shows "Ops API unreachable" | The API is down. `npm run dev:server`. |
| Workers = 0 | `npm run dev:workers`. |
| Uploads stay "queued" forever | No workers running — same fix. |
| `setup:db` says access denied | Wrong `DB_PASS` in `server/.env`. |
| Backlog never grows during the load test | Workers are draining it as fast as it arrives. Raise the rate: `npm run loadtest -- --rps 600 --sessions 800`. |
