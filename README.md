# ChargeOps — EV Charging Network Operations Platform

ChargeOps is an internal operations platform for an EV charging network. Five
roles use it, and each signs in to a different home screen, because each one
arrives with a different question:

| Role | Opens on | The question they came to answer |
|---|---|---|
| **Operations manager** | `/` | Is the network up, what is waiting on a technician, and what did today earn? |
| **Field technician** | `/my-work` | What am I doing next, and where? |
| **Finance** | `/revenue` | What needs approving, and does the money reconcile? |
| **Site host** | `/my-sites` | How busy were my bays, and what am I owed? |
| **Read-only viewer** | `/` | The operations picture, with nothing to press. |

A site host is a landlord within the network, not an operator of it — the
shopping centre or hotel whose car park the chargers sit in. Their account is
confined to their own company's rows by filters applied in SQL, and it never
sees a driver's identity. That row-level tenancy is the piece that makes this a
multi-tenant platform rather than a single-company admin tool, and it is
enforced server-side (`server/lib/scope.js`), never in the browser.

It is **not** a public driver application. Driver, session and payment records
are operational data managed by staff.

The project began as a relational-database course project and was extended for
a cloud-computing final project. Milestone 1 runs the entire three-tier system
locally; Milestone 2 replaces local adapters with AWS managed services.

## Milestone 1 architecture

```text
Browser
  │
  ▼
React + Vite :5173
  │ /api
  ▼
Express :4000 ───────────────► local object storage
  ▲   │                              ▲
  │   ├──────────► MySQL job_queue ──┤
  │   │                    │          │
  │   ▼                    ▼          │
  │ MySQL :3306     autoscaling workers
  │
  └── simulated charger fleet
```

The fourth process is not part of the platform. It stands in for the chargers
themselves, which in a real deployment send these events on their own — a
session starting, a session ending, a heartbeat. Without it the system is
correct and completely still: the reaper closes the seeded sessions, nothing
opens new ones, and the fleet settles at zero in use. `npm run dev:all` starts
it; `npm run dev:quiet` leaves it out.

The relational database carries the 11 business tables from the database course
project:

`company`, `user`, `membership`, `technician`, `station`, `wallet`,
`subscription`, `charger`, `charging_session`, `payment`, and
`maintenance_log`.

Nine tables were added for the cloud work:

`job_queue`, `attachment`, `invoice`, `charger_telemetry`, `worker_node`,
`audit_log`, `billing_request`, `simulation_run`, and `app_meta`.

Two of those are worth a sentence. `billing_request` is the finance queue —
memberships, top-ups and refunds waiting on a human decision — and it exists so
that money never moves as a side effect. `app_meta` records where the seeded
data ends, because "was this row seeded or did the application produce it?" is a
question several checks have to answer and no timestamp can.

Three data-integrity triggers remain in MySQL. Billing and other retryable
business work run in workers, where they can scale, retry and produce files.

## Features

### Operations manager

- Fleet dashboard with network counts, revenue, availability and recent activity
- Searchable station and charger inventories
- Manual charger disable/restore with a required reason and audit history
- Customer, subscription, charging-session and payment reporting
- Maintenance assignment, start, resolve and reopen workflow
- Live queue depth, worker count, throughput, latency, cache and DLQ controls
- Server-side filtering and pagination for large operational tables

### Field technician

- A job list restricted to their own work, ordered critical first then oldest
- Start and resolve, in that order — a technician cannot close a job they never
  started, because that records a repair with no duration and mean time to
  repair is the number the operation is measured on
- Equipment history for any bay: past faults, average repair time, and a
  "repeat offender" flag at four failures in ninety days
- Fault photo and service-report upload
- Automatic EXIF/GPS, PDF text, fault category, severity and error-code extraction
- Automatic work-order creation, with an explicit choice about whether the bay
  goes out of service

### Finance

- An approval inbox: new memberships, renewals, wallet top-ups and refunds.
  Approving writes the payment and activates the subscription in one
  transaction
- Collections: sessions where the energy was delivered and every payment
  attempt failed, split by whether the driver's wallet covers the debt.
  Collect settles it from the wallet; write off forgives it on the record with
  a reason
- Revenue by source over time, with customer deposits charted alongside and
  never counted as revenue — a top-up is money held, not earned
- Reconciliation: every settled session should produce one successful payment
  and one invoice
- Invoices: every PDF the billing worker rendered, searchable by number, driver,
  station or session, each with a signed download link that expires in fifteen
  minutes

### Site host

- Their own sites only, filtered in SQL from the company id signed into their
  token, with utilisation and their share of the revenue
- A statement rather than a dashboard: earnings by day, by hour of the day, and
  every session line the total adds up from
- No driver identity at any level of detail — never selected, not filtered out
  afterwards

### Asynchronous pipeline

- Session billing is queued and idempotent
- Payment/session completion atomically creates a separate invoice-generation job
- PDF generation retries independently, so it cannot replay a wallet debit
- Telemetry is queued and written in batches
- Workers use visibility timeouts, exponential retry and a dead-letter state
- Backlog-driven local autoscaling demonstrates the control loop used by ECS,
  Lambda or Kubernetes autoscaling

## Running it on your machine

Six steps, about ten minutes, most of which is one command downloading things.
Follow them in order — step 4 has to happen before step 5.

### 1. Install the two prerequisites

| | Version | Check it with |
|---|---|---|
| Node.js | 18 or newer | `node -v` |
| MySQL | 8.0 or newer | `mysql --version` |

On Windows, the MySQL installer registers MySQL as a service that starts with
the computer. Confirm it is running before going further — every later error
looks like an application bug when the database is simply down:

```powershell
Get-Service -Name "MySQL*"
```

`Status` must read `Running`. If it does not, start it from Services, or
`net start MySQL80` in an administrator terminal (use whatever name the command
above printed).

### 2. Get the code and its dependencies

```bash
git clone <the repository URL>
cd ChargeOps
npm ci
```

`npm ci` installs the exact versions in `package-lock.json`. It takes a couple
of minutes and prints some audit warnings at the end — those are transitive
dependencies and are listed under Known limitations below; they do not stop
anything.

### 3. Create your two config files

```bash
cp .env.example .env
cp server/.env.example server/.env
```

On Windows PowerShell use `copy` instead of `cp`.

### 4. Put your MySQL password in `server/.env`

Open `server/.env` and change **one line**:

```ini
DB_PASS=yourpassword        ← your own MySQL root password
```

Everything else in that file works as shipped, including the demo account
passwords. If your MySQL runs on a non-default port or user, change `DB_PORT`
and `DB_USER` too.

> `server/.env` is gitignored, so your password never leaves your machine. The
> demo passwords in it are deliberately weak and in plain text — fine for a
> local classroom demo, not fine anywhere other people can reach. See Known
> limitations.

### 5. Build the database

```bash
npm run setup:db
```

This creates the `ev` database, loads the schema and seed data from the
database course project, adds the tables this platform needs, and generates
about 35,000 charging sessions of realistic history. It takes **60 to 90
seconds** and prints what it did at each step, finishing with:

```text
✔ Database ready.
```

It is safe to run more than once — every step checks whether it already
happened, so a second run changes nothing.

### 6. Start it

```bash
npm run dev:all
```

Windows users can double-click `start.cmd` instead, which does the same thing
and checks MySQL first.

Four processes start in one terminal. Wait for the line that reads
`VITE ready`, then open:

**<http://localhost:5173>**

**Leave that terminal open.** The four processes live inside it, so closing the
window stops the application. `Ctrl+C` stops it deliberately.

### What you should see

Sign in as `ops` — the password is `chargeops-demo`, and the sign-in screen
lists every account.

| If it worked | You will see |
|---|---|
| Dashboard | Fleet availability around 92%, a dispatch queue with about 29 items, a mean time to repair in hours, and revenue for today |
| Sessions | Roughly 100–150 sessions charging right now, and the number moves while you watch |
| Map | 51 sites plotted across the United States |
| Invoices | A handful at first, growing as the simulated fleet settles sessions — every one a real PDF with a working download |

If the numbers are all zero, the database step did not finish — re-run
`npm run setup:db` and read its output.

The invoice count starts small on purpose. Invoices are PDFs the billing worker
renders, so they exist only for sessions this application settled — the 35,000
seeded sessions predate it and are exempt. Leave the app running, or stop a
session yourself from the Sessions page, and the number climbs.

### Confirming your install matches everyone else's

```bash
npm run doctor
```

**71 checks must pass.** This is the command to run before you report a
problem: it verifies the schema, referential integrity, work-order states,
physics, money, timestamps, tenancy and the live API, and each failure names
the rule it broke rather than printing a stack trace.

Two teammates who both see 71 passing have the same installation. The data is
generated by arithmetic on row ids rather than random numbers, so two clean
installs produce identical totals — only the count of sessions charging right
now will differ, because the simulated fleet has been running for a different
length of time on each machine.

`npm run smoke` (26 API and permission checks) and `npm run selftest` (26
file-extraction checks, no database needed) round it out.

### After you restart your computer

MySQL comes back on its own because it is installed as a Windows service.
**Node is not**, so nothing is listening on 5173 until you start it again —
which is why the database looks healthy while the page refuses to open.

```bash
npm run dev:all
```

That is all. Your data is still there; `setup:db` is not needed a second time.

### If something goes wrong

| Symptom | Cause and fix |
|---|---|
| `ECONNREFUSED` or `Access denied for user` on `setup:db` | MySQL is not running, or `DB_PASS` in `server/.env` is wrong |
| `localhost:5173` will not open | `npm run dev:all` is not running, or its terminal was closed |
| Sign-in says "invalid username or password" | The password is `chargeops-demo` unless you changed `AUTH_*_PASSWORD` in `server/.env` |
| Sign-in says "too many attempts — try again in N seconds" | The rate limiter, working as intended: 10 attempts a minute per IP. Wait it out |
| Dashboard numbers are all zero | `setup:db` did not complete — run it again and read the output |
| Everything loads but nothing moves | The simulated fleet is not running. Use `npm run dev:all`, not `npm run dev` |
| `npm run doctor` reports failures | Read the failing line; it names the rule. `npm run data:audit` explains, `npm run data:repair` fixes the repairable ones |

## Signing in

Every account uses the password `chargeops-demo` unless you changed the
`AUTH_*_PASSWORD` values in `server/.env`. The sign-in screen lists them too, so
nobody has to keep this page open.

| Role | Username | Lands on |
|---|---|---|
| Operations manager | `ops` | Network operations |
| Field technician | `tech` | My work |
| Finance | `finance` | Revenue |
| Site host | `host` | My sites |
| Read-only viewer | `viewer` | Network operations |

Two of those five are not single accounts. **Any technician on record signs in
as `tech<their id>`** — `tech19`, `tech101` — and **any site host as
`host<id>`**:

| Account | Site host | Sites | Bays |
|---|---|---:|---:|
| `host1` | Cascade Retail Group — shopping centres | 7 | 133 |
| `host2` | Harborview Hotels | 7 | 119 |
| `host3` | Sunbelt Medical Centers — hospital campuses | 6 | 105 |
| `host4` | Metro Transit Authority — park and ride | 7 | 124 |
| `host5` | Lone Star Logistics Parks | 10 | 158 |
| `host6` | Greenway Office Campuses | 14 | 220 |

Both resolve against the business data rather than a list in the source, which
is the point worth showing: a technician is a row in `technician`, a site host
is a row in the `company` table — the only place that word survives, because it
is the schema's. The six partition the network exactly — 51 sites, 859 bays, no
overlap.

### The five-minute tour

Signing in as each role in turn is the fastest way to see that the permission
model is real rather than cosmetic.

1. **`ops`** — the dashboard answers four questions in order: is the network up,
   what is waiting on a technician, are repairs closing fast, did today earn.
   Open **Dispatch** and assign a work order; the technician list is ranked by
   distance from that charger, and each name shows its id.
2. **`tech<that id>`** — the job you just assigned is in their queue and nobody
   else's. There is a **Start** button and no Resolve, because a technician
   cannot close a job they never started.
3. **`finance`** — an approval inbox, a collections queue where the driver's
   wallet balance decides whether you collect or write off, and the invoices the
   billing worker rendered.
4. **`host1`**, then **`host6`** — seven sites, then fourteen, with no overlap
   and no driver name anywhere. That is the tenancy boundary, and it is enforced
   in SQL rather than in the browser.
5. **`viewer`** — everything visible, nothing pressable.

Worth trying: as `tech`, type `/users` into the address bar. You are returned to
your own job list, and the API refuses the same request independently.

> **Known limitation, stated deliberately.** Every technician shares one
> password and it is stored in plain text. That is acceptable for a local
> Milestone 1 demo and not acceptable in production: a real deployment needs
> per-user password hashes (bcrypt/argon2) or an external identity provider.
> Only `resolveTechnicianLogin()` in `server/auth.js` would change. The local
> HMAC token provider is likewise a Milestone 1 adapter; the AWS deployment
> should replace it with Cognito or another OIDC provider.

The login endpoint is rate limited to 10 attempts per minute, so a script that
signs in repeatedly will start receiving HTTP 429.

## Quick start — Docker Compose

Docker Compose starts a clean, production-shaped local environment:

Prerequisite: Docker Desktop (with Compose v2) must be installed and running.

- `web`: Nginx serving the React build on `:8080`
- `api`: Express on `:4000`
- `worker`: autoscaling worker supervisor
- `db`: MySQL 8.4 on host port `3307`
- `migrate`: one-shot schema, seed and migration job

```bash
docker compose up --build -d
docker compose logs -f migrate api worker
```

Open <http://localhost:8080>. Stop the stack with:

```bash
docker compose down
```

> **Not verified on this machine.** The Compose files are complete and the
> service definitions are correct as written, but Docker Desktop was not
> installed while this milestone was built, so `docker compose up` has never
> actually been run. Milestone 1 is graded on the native path above, which is
> exercised end to end by `npm run doctor`. Treat Compose as untested until
> somebody runs it. Note also that it has no `fleet` service, so a Compose
> deployment goes quiet once the seeded sessions close — run
> `npm run traffic` against it, or add a fourth service.

Database and object-storage data live in named volumes. To deliberately remove
the Docker data as well, use `docker compose down -v`.

If native MySQL/API services are already using ports 3306 or 4000, stop the
native API before starting Compose. Docker publishes its MySQL service on 3307,
so it does not conflict with a normal local MySQL installation.

## Commands

| Command | Purpose |
|---|---|
| `npm run doctor` | **The one to run before packaging this for anyone.** 71 invariants across schema, referential integrity, work-order state, physics, money, time, tenancy and the live API. Fails loudly and names the rule. |
| `npm run doctor -- --db-only` | The same, skipping the checks that need the API running |
| `npm run setup:db` | Idempotently create/update schema, constraints, seed and reporting package |
| `npm run seed:demo` | Generate sample technician photos and reports |
| `npm run seed:activity` | Shape the data into a live operating picture: spread bulk history over a realistic daily curve, put ~18% of chargers mid-session. Re-run after a load test. |
| `npm run seed:activity -- --dry` | Report what it would change without touching anything |
| `npm run traffic` | Continuous human-paced traffic through the real API — starts sessions on a daily demand curve, ends them naturally, heartbeats the fleet. Run alongside the app for a deployment that stays alive on its own. |
| `npm run traffic:once` | A single traffic tick, for a cron schedule instead of a long-running process |
| `npm run dev:all` | Run all four processes: API, worker supervisor, simulated charger fleet and the Vite frontend |
| `npm run dev:quiet` | The same without the simulated fleet, if you want the data to hold still |
| `npm run selftest` | Run extraction/classification tests without a database |
| `npm run smoke` | Verify authentication, RBAC, pagination and main APIs |
| `npm run build` | Type-check and create the production frontend build |
| `npm run loadtest` | Generate billing and telemetry spikes |
| `npm run loadtest:sync` | Run the inline-billing control profile |
| `npm run data:audit` | Read-only check for known wallet, billing, subscription, charger and invoice anomalies |
| `npm run data:repair` | Snapshot affected rows locally, then repair those anomalies in one transaction |
| `npm run simulate:day` | Idempotently enqueue today's deterministic platform simulation |
| `npm run simulate:status` | Show the daily MySQL Event and the latest simulation runs |
| `npm run simulate:enable` | Enable the daily simulation Event |
| `npm run simulate:disable` | Pause future simulation runs without deleting existing data |
| `npm run docker:up` | Build and start the Compose stack |
| `npm run docker:down` | Stop the Compose stack |

Health check: <http://localhost:4000/api/health>.

## Verifying an installation

Three suites, and they answer different questions. Run all three after a fresh
install; if they pass on your machine and on a teammate's, the two installations
agree.

```bash
npm run doctor      # 71 invariants against the database and the live API
npm run smoke       # 26 checks on authentication, RBAC and the main endpoints
npm run selftest    # 26 checks on EXIF/PDF/classification, no database needed
```

`doctor` is the one that matters. It is not a test suite over the code; it is a
set of statements about the data that must be true no matter how the rows got
there, and each failure names the rule rather than a stack trace:

- no session delivered more energy than a car battery holds, or than its
  charger could physically supply in that time
- no session ends before it starts, and nothing is timestamped in the future
- no wallet is overdrawn, no session is billed twice, every successful payment
  matches its session total
- a work order awaiting dispatch has no technician on it, and one that is
  assigned has one
- every router is mounted behind `allowRoles`, and a site host is refused all
  six cross-tenant probes — checked by actually signing in as one, not by
  reading the code

Several of those exist because the thing they check was once wrong.

The data is deterministic: every generated value comes from arithmetic on row
ids rather than a random seed, so two clean installs produce identical
aggregates. Live session counts will differ, because the simulated fleet has
been running for a different length of time.

## Running continuously

Deploying the application to a server that stays up does not by itself give a
platform that looks alive. Everything the system does is a reaction to a driver
or a charger, and a demo deployment has neither: the stale-session reaper closes
the seeded sessions within hours, the daily simulator only writes history, and
no charger sends heartbeats. The system behaves correctly and settles at zero
chargers in use.

`npm run traffic` supplies the missing demand. It runs alongside the API and
workers, and every action goes through the ordinary HTTP endpoints — the same
authentication, validation, queue and billing worker a real session uses:

- starts sessions to meet a target occupancy that follows the hour of the day,
  so mornings and evenings are busy and 04:00 is quiet;
- stops each session once it has run a length appropriate to its charger — about
  twenty minutes on a 350 kW stall, several hours on a 7 kW one;
- heartbeats a slice of the fleet each tick, so telemetry and its ingest lag stay
  meaningful.

For a long-lived deployment run it as a fourth process next to the API, the
worker supervisor and the web server. On a schedule-only platform, run
`npm run traffic:once` every minute instead.

Do not confuse it with `npm run loadtest`. The load test is a deliberate burst
that answers "where does this bend?"; the traffic simulator is an ordinary day
at human pace that answers "what does this look like when nobody is testing?".

## Authentication and authorization

All API routes except `/api/health`, `/api/auth/*`, and HMAC-signed
`/api/files/*` downloads require a bearer token.

Permissions:

| Capability | ops_manager | technician | finance | site_host | viewer |
|---|---:|---:|---:|---:|---:|
| Station / charger read | Yes | Yes | No | Own sites | Yes |
| Network-wide dashboards | Yes | No | Yes | No | Yes |
| Own-site performance and revenue share | Yes | No | No | Yes | Yes |
| Driver, session and payment data | Yes | No | Yes | No | Yes |
| Work-order read | Yes | Own queue | No | Own sites | Yes |
| Raise a work order | Yes | Yes | No | No | No |
| Assign work orders | Yes | No | No | No | No |
| Start / resolve a work order | Yes | Own queue | No | No | No |
| Reject a work order | Yes | No | No | No | No |
| Raise a billing request | Yes | No | No | No | No |
| Approve / reject a billing request | No | No | Yes | No | No |
| Start / stop a charging session | Yes | No | No | No | No |
| Upload / reprocess field files | Yes | Yes | No | No | No |
| Disable / restore chargers | Yes | No | No | No | No |
| Redrive / purge queue jobs | Yes | No | No | No | No |

Two rows there are worth reading twice.

**"Own sites" is not the same kind of permission as "Yes" or "No".** Everywhere
else the question is *may this role reach this endpoint*, answered once by
`allowRoles`. For a site host the endpoint is allowed and the question becomes
*which rows may they see*, which has to be answered inside every query — list
endpoints and detail endpoints alike. Filtering a list is the visible half and
the easy half to remember; `GET /api/stations/:id` never passes through that
filter, so it carries its own check.

**Operations can raise a billing request but cannot approve one, and finance is
the reverse.** Whoever asks for money to move and whoever authorises it have to
be different people, or the approval means nothing.

The API also applies an origin allowlist, security headers and in-memory rate
limits. AWS should move rate limiting to API Gateway/ALB/WAF and authentication
to Cognito/OIDC.

## Consistency model

The local queue is the MySQL `job_queue` table. Routes that change relational
state use the same database transaction to enqueue their job, so a session
cannot be marked ended without a billing job.

Uploads use a compensating transaction: bytes are written first, then metadata
and the queue row commit together; failure removes the stored object.

Billing uses two jobs:

1. Lock the session, compute the charge, debit the wallet or record card payment,
   complete the session and enqueue invoice generation in one transaction.
2. Render/store the PDF and upsert the invoice record independently.

Database unique constraints enforce one charging payment and one invoice per
session in addition to handler-level idempotency.

## Daily platform simulator

`npm run setup:db` installs and enables the MySQL Event
`evt_chargeops_daily_simulation`. At 00:10 in the database server's local time,
it enqueues one simulation for the previous calendar day. The worker creates
12–24 completed charging sessions, bills them through the normal wallet/card
path, generates invoices, emits telemetry, and creates 1–3 maintenance
situations. It also resolves a small number of older simulated situations so
the fleet does not become permanently unavailable.

One `simulation_run` row is allowed per date, so retries and repeated manual
commands do not duplicate data. Adjust the four `SIMULATION_*` bounds in
`server/.env`; Docker enables MySQL's Event Scheduler automatically. To run a
specific day manually:

```bash
node scripts/simulator.mjs run --date 2026-08-31
```

The database Event is only the clock. Business logic remains in the Node
worker, which is the local equivalent of EventBridge Scheduler feeding SQS and
an ECS/Lambda worker in the cloud design.

## Milestone 2 AWS map

| Local component | AWS target |
|---|---|
| React/Nginx | S3 + CloudFront |
| Express API | ECS Fargate + Application Load Balancer |
| MySQL | RDS for MySQL |
| Local object storage | S3 |
| MySQL `job_queue` | SQS + DLQ |
| MySQL daily Event | EventBridge Scheduler |
| Forked worker processes | ECS worker service or Lambda |
| Supervisor metrics | CloudWatch metrics and scaling policy |
| In-process cache | ElastiCache for Redis |
| Local authentication | Cognito/OIDC |
| Environment secrets | Secrets Manager |

The table-name convention is consistently lowercase so the same schema and
queries work on Windows MySQL and case-sensitive Linux/RDS installations.

## Project layout

```text
src/                    React application
  context/AuthContext   login state and role checks
  pages/                dashboard and operational workflows
server/
  auth.js               local signed-token provider and RBAC middleware
  adapters/             queue, storage and cache migration seams
  routes/               Express HTTP layer
  workers/              supervisor, workers and job handlers
  sql/                  relational schema, cloud schema and reporting package
scripts/                 setup, samples, smoke tests and load tests
docker/                  Nginx configuration
Dockerfile               web and Node runtime targets
docker-compose.yml        complete local environment
docs/                     architecture and demo runbook
```

## Known Milestone 1 limitations

- The queue shares MySQL capacity with the operational database; AWS moves it
  to SQS.
- Rate limits and cache entries are process-local; AWS uses WAF/API Gateway and
  Redis.
- Local passwords are environment variables for classroom demonstration;
  production uses an identity provider and managed secrets.
- The card-payment fallback is simulated and does not call a payment processor.
- The keyword/PDF/EXIF extractors are deliberately local stand-ins for managed
  document and ML services.
- Docker Compose is written but has never been run — see the note in its
  section. The native path is the one that is verified.
- Dependency audit reports 6 moderate/low advisories in transitive packages.
  They do not affect a local classroom deployment and are listed here rather
  than silently carried.
- The simulated charger fleet is a local stand-in for the chargers themselves.
  A real deployment deletes that process, because real hardware sends those
  events.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design rationale and
[docs/DEMO.md](docs/DEMO.md) for the presentation flow.

## License

MIT
