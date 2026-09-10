# ChargeOps — 10-minute demo runbook

Everything for the Milestone 1 video, in the order you show it, with the words
to say and the exact clicks.

## The shape of the video

| Time | Section |
|---|---|
| 0:00 – 0:30 | Opening |
| 0:30 – 1:15 | The team, and who built what |
| 1:15 – 2:15 | Why this domain |
| 2:15 – 4:45 | The three layers: front end, application, database |
| 4:45 – 9:15 | The five people who use this, and what each of them does |
| 9:15 – 10:00 | Close |

### Who presents

| Time | Presenter |
|---|---|
| 0:00 – 2:15 | **1** — opening, team, domain |
| 2:15 – 4:45 | **2** — the three layers |
| 4:45 – 9:15 | **3** — the five roles |
| 9:15 – 10:00 | **1** — close (whoever opened should close) |

Presenter 3 has the longest stretch. If you want it more even, presenter 2 can
carry the first two roles as well and hand over at the finance section.

### One thing to keep in mind

The layers come before the demo in this order, which reads well — but a narrated
architecture is not the same as a working one, and the assignment asks for
"functioning together". So the layer section does not just describe the tiers:
it shows a real request in DevTools and runs a real query against MySQL. Keep
those two moments in even if you are running short.

---

## Before you hit record

Start the stack and leave it running:

```bash
npm run dev:all
```

That is four processes in one terminal — the API on `:4000`, the autoscaling
worker pool, a simulated charger fleet, and Vite on `:5173`. **Leave the
terminal open**; closing it stops everything.

Generate the sample fault photos and reports you will upload:

```bash
npm run seed:demo
```

Confirm the install is sound — the fastest way to know the demo will not
embarrass you:

```bash
npm run doctor
```

**71 checks must pass.**

### Have these open before recording

1. `http://localhost:5173` — signed out, ready for the first sign-in
2. **DevTools** on that tab, **Network** panel, cleared
3. **MySQL Workbench** connected to the `ev` database, with the query below
   already typed into a tab so you never type SQL on camera
4. Your terminal, font size bumped

### Decide these before the camera is on

- **Which charger** gets a fault reported. Write down its id.
- **Which technician** the dispatch dialog assigns — the list shows each id.
  Write it down; the technician section signs in as `tech<that id>`.
- **Which session id** you will trace in the SQL query.

---

## The 10 minutes

### 0:00 – 0:30 · Opening

**Presenter 1, camera on. No screen share yet.**

> "This is ChargeOps, an operations platform for a public EV charging network.
> Everything you are about to see runs locally: a React front end, a Node
> application layer with background workers, and a MySQL database."

### 0:30 – 1:15 · The team, and who built what

Still camera on. Name each member and the part they owned — this is 45 seconds,
so one clause each, not a paragraph.

| Member | Owned |
|---|---|
| | Front end, the role-based screens |
| | API, authentication and permissions |
| | Database design and data integrity |
| | Workers, queue and autoscaling |
| | File processing, testing, documentation |

> **Fill the names in on your own copy — do not commit them.** This repository
> is public, and a public commit history is a permanent record of five people's
> names that only one of you agreed to publish.

### 1:15 – 2:15 · Why this domain

> "EV adoption is accelerating, and self-driving fleets will push it further —
> a car that drives itself still has to charge itself. Charging networks are
> about to grow from dozens of chargers to thousands, spread across sites nobody
> visits on a normal day.
>
> Past a certain size an operator cannot walk the estate any more. They find out
> a charger is broken because a driver complained, and every hour it stays down
> is lost revenue and a customer who may not come back. That is the gap this
> platform fills.
>
> We chose it because it is where the industry is going, and because it has real
> depth — there is always another layer to build. It is also work we would be
> happy to talk about in an interview."

Say plainly what carried over and what is new: the relational model comes from
our database course project; the roles, the file processing, the queue and the
autoscaling are new for this course.

### 2:15 – 3:00 · Layer 1 — the front end

**Presenter 2, share screen.** Sign in as `ops` / `chargeops-demo`.

> "React and Vite. Five different sign-ins produce five different applications —
> the navigation, the landing page and the available actions all come from the
> user's role, not from hiding buttons."

Point at the sidebar. Say that a viewer gets the same pages with every action
removed, and that a technician gets four items where an operations manager gets
ten.

> "The browser never talks to the database. Every number on this page arrived
> as JSON from the API."

### 3:00 – 4:00 · Layer 2 — the application layer

**Open DevTools, Network panel.** This is the layer nobody can see, so show it.

Go to **Sessions**, pick one that is charging, and press **Stop & bill**. Point
at the request in the Network panel:

> "`POST /api/sessions/:id/stop`, and the answer is **202 Accepted**, not 200.
> That is deliberate. The request does only what cannot wait — it ends the
> session, frees the bay, and queues the billing job, all in one transaction, so
> a session can never end without its bill existing. Then it returns.
>
> The money and the invoice happen behind it. A billing worker charges the
> wallet and writes the payment; a second worker renders the invoice PDF. They
> are separate jobs on purpose: the PDF can fail and retry all day without ever
> charging the driver twice."

Switch to the **Cloud ops** page for about ten seconds:

> "This is the queue and the worker pool. When many sessions end at once the
> backlog grows, and the supervisor starts one more worker for every 25 jobs
> waiting, up to eight — the same control loop ECS or Lambda runs against an SQS
> queue."

### 4:00 – 4:45 · Layer 3 — the database

**Switch to MySQL Workbench.** Do not browse the schema tree table by table.
Run one query and let it make three points at once:

```sql
SELECT s.Session_ID, s.Energy_Consumed, s.Total_Cost,
       p.Payment_ID, p.Payment_Status,
       i.Invoice_Number, i.Storage_Key
FROM   charging_session s
JOIN   payment p ON p.Session_ID = s.Session_ID
JOIN   invoice i ON i.Session_ID = s.Session_ID
ORDER  BY s.Session_ID DESC
LIMIT  5;
```

> "Twenty tables. Here is the session we just stopped, the payment it produced,
> and its invoice — one row, three tables, joined on the session id.
>
> Two things worth pointing at. There is exactly one payment and one invoice per
> session, and that is a unique index, not a check in our code. And the last
> column is a **storage key**, not a PDF. The file itself lives in object
> storage; the database holds a path to it. Large files do not belong in MySQL."

If you have a second, run `SHOW TABLES;` so the twenty are visible on screen.

### 4:45 – 9:15 · The five people who use this

**Presenter 3, camera on for the intro, then share screen.**

> "Five roles, five different jobs. Each one signs in and lands on the question
> they actually care about."

Do them in this order — it follows one fault from report to payment, so it plays
as a story rather than five separate tours.

#### `ops` — the operations manager *(about 1:10)*

> "First thing in the morning: is the network up, what is waiting on a
> technician, are repairs closing fast enough, did yesterday earn."

The **Operations** page answers those four in that order. Point; do not read.

1. Open **Chargers**, find your charger, **report a fault**. It leaves Available
   immediately — the bay is out of service the moment the fault is filed.
2. Open **Dispatch**. The work order is there, awaiting dispatch.
3. Open the assign dialog. Say the technician list is **ranked by distance from
   that charger**, and each name shows its id.
4. Assign it, and **read the technician's id out loud.**

#### `tech<id>` — the field technician *(about 1:10)*

Sign in as that technician.

1. **My work** — the job you just created is here, and it is the only one.
   Nobody else can see it.
2. There is a **Start** button and no Resolve: a technician cannot close a job
   they never started. Press **Start**.
3. **Field uploads** — drag in both `samples/02-cable-damage-photo.jpg` and
   `samples/02-cable-damage-report.pdf`. The response is `202` again.
4. The cards flip from queued. Walk the derived fields:
   - **`critical` / `cable` / `E-1180`** — read out of the report's prose;
     nobody typed them into a form.
   - **GPS matched \<station\>** — the photo's EXIF tag, matched against station
     coordinates. The photo reported where it came from.
   - Severity is critical, so the charger was taken out of service
     automatically.
5. **Resolve** the work order.

#### `finance` *(about 1:00)*

> "The charger is fixed. Now the money has to be right."

- **Revenue** — what the network earned and from what.
- **Collections** — drivers whose payment failed. Show one where the wallet
  covers it and **retry the charge**; show one where it does not and **write it
  off**. A decision the platform supports, not a table you stare at.
- **Invoices** — the PDFs those workers rendered. **Download one on camera.**

#### `host1` — a site host *(about 0:40)*

> "Site hosts are the property owners — a shopping centre, a hotel group, a
> hospital campus. They own the land, we run the chargers, and they get a share
> of what those chargers earn."

- **My sites** — seven sites. Sign in as `host6` for a second and it is
  fourteen, with no overlap.
- **Earnings** — their cut, and nobody else's.

> "No driver names anywhere. That boundary is a `WHERE` clause in SQL, not
> hidden buttons in the browser."

#### `viewer` *(about 0:30)*

> "Read-only. Same pages, every action gone."

Then the one that lands:

> "And it is not just the buttons. Type `/users` into the address bar as a
> technician —" *(do it)* "— you are put back on your own job list, and the API
> refuses the same request independently. Two locks, not one."

### 9:15 – 10:00 · Close

**Presenter 1, camera back on.**

- A working local application: React front end, Node application layer with
  workers, MySQL and object storage — all three live, and you watched one action
  cross all of them.
- One core flow: a fault is found, dispatched, fixed with photographic evidence,
  and billed.
- A domain we picked because it is where the industry is heading.

One sentence on Milestone 2: every box already has a managed service behind it —
RDS, S3, SQS, ECS — so the migration is a substitution, not a rewrite.

---

## Recording notes

- **Cameras on** for every presenting member during their own section.
- Record at 1080p and bump terminal, Workbench and browser font size — native
  size is unreadable after compression. Workbench results grids are the worst
  offender; zoom that in before you start.
- **Rehearse the two handoffs**: presenter 1 must say the technician id clearly,
  and the technician section must be ready to sign in with it. That transition
  is the most convincing moment in the video — fumbling it wastes it.
- Have the SQL already typed in a Workbench tab. Typing a join on camera is
  thirty seconds you do not have, and a typo is worse.
- Target 9:30 so the final cut stays under the limit.

## If something breaks on camera

| Symptom | Fix |
|---|---|
| Cloud ops shows "Ops API unreachable" | The API is down. `npm run dev:server`. |
| Workers = 0 | `npm run dev:workers`. |
| Uploads stay "queued" forever | No workers running — same fix. |
| The technician's queue is empty | Wrong account. It is `tech<id>`, the id from the dispatch dialog. |
| The SQL query returns nothing | Drop the `WHERE` and use `ORDER BY s.Session_ID DESC LIMIT 5` — any recent session will make the same point. |
| Sign-in says "too many attempts" | The rate limiter, 10 a minute per IP, working as designed. Wait it out. |
| Dashboard numbers are all zero | `setup:db` did not finish. Re-run it and read the output. |
