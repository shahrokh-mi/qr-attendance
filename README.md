# qr-attendance

A small-company attendance collector with an employee portal. Employees scan a QR code
shown on an entrance monitor with their phone's normal camera; the browser page records a
**raw attendance event** with a **server-assigned timestamp**. Nothing else is derived: no
entry/exit, no shift length, no lateness, no payroll.

Next.js 16 (App Router) + React 19 + TypeScript on Vercel's Hobby plan, with a real
Postgres database (PGlite, WASM) persisted as a single snapshot object in Vercel Blob. No
third-party database account, no paid tier.

---

## 1. What it does

| Surface | Route | Who | Behaviour |
| --- | --- | --- | --- |
| Entrance display | `/display` | Provisioned monitor | Full-screen QR, rotated every N seconds, live connection state |
| Scan landing | `/scan?challenge=…` | Public | Exchanges the code, records the event automatically, or asks for one sign-in |
| Sign-in | `/login` | Public | Username/password; finishes a pending scan automatically |
| My attendance | `/attendance` | Employee | Own raw events, defaulting to today |
| Account | `/account` | Any signed-in user | Change own password |
| Users | `/admin/users` | Admin | Create, edit, deactivate, promote/demote, reset passwords |
| Settings | `/admin/settings` | Admin | QR rotation interval, display activation/revocation |
| All attendance | `/admin/attendance` | Admin | Every employee's events, filterable |

Out of scope by design: public self-registration, native apps, MAC/passkey identification,
location or office-network enforcement, offline attendance, salary receipts, ERP
integration. Employee IDs and employee codes are stable so an ERP mapping can be added
later.

---

## 2. Architecture in one paragraph

One deployable unit, one origin, one language. Route handlers under `app/api/v1/**` run on
the Node.js runtime. The database is **PGlite** — genuine Postgres compiled to WASM — whose
whole datadir is dumped to a gzipped tarball and stored as one object in Vercel Blob.
`withDatabase()` (`lib/db/controller.ts`) is the only thing that knows this: it boots an
in-memory Postgres from the snapshot, runs pending migrations, and after every mutation
dumps and conditionally re-uploads the snapshot. Concurrency is optimistic: two instances
may both work, but only one conditional write lands, and the loser reloads and retries.

```
request ──► withDatabase(fn)
             ├─ stat() snapshot ETag            (1 simple Blob op)
             ├─ load PGlite memory:// + migrations + seed   (first use per instance)
             ├─ fn(db)  ← inside one transaction
             └─ dumpDataDir() ─► put(ifMatch: etag)          (1 advanced Blob op)
```

---

## 3. Quick start (local)

```bash
npm ci
cp .env.example .env.local     # then set QR_CHALLENGE_SECRET
npm run dev                    # http://localhost:3000
```

Minimum local `.env.local`:

```ini
PUBLIC_BASE_URL=http://localhost:3000
STORAGE_MODE=file
QR_CHALLENGE_SECRET=<32+ random chars, e.g. `openssl rand -base64 48`>
COOKIE_SECURE=false
DISPLAY_TIMEZONE=Asia/Tehran
BOOTSTRAP_ADMIN_PASSWORD=admin
```

First request seeds one administrator: **admin / admin**. The UI keeps showing a
"change the default password" banner until it is changed — do that before the deployment is
reachable from outside your network. `npm run db:reset` deletes the local snapshot so the
next request re-seeds.

### Testing the phone flow

1. **Same Wi-Fi (plain HTTP, disposable data).** Run `npx next dev -H 0.0.0.0`, set
   `PUBLIC_BASE_URL=http://<LAN-IP>:3000`, `COOKIE_SECURE=false`, open the firewall for
   port 3000, and browse to `http://<LAN-IP>:3000` from the phone.
2. **HTTPS tunnel (realistic).** Cloudflare Quick Tunnel: `cloudflared tunnel --url
   http://localhost:3000`, then set `PUBLIC_BASE_URL` to the tunnel origin and
   `COOKIE_SECURE=true`. Quick Tunnel hostnames change per run, which means new cookies and
   a display that must be re-provisioned.

---

## 4. Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | Canonical origin for QR URLs and Origin/Referer checks | dev `http://localhost:3000`, required in production |
| `STORAGE_MODE` | `file` (local snapshot) or `blob` (Vercel Blob) | `file` unless a Blob token exists in production |
| `SNAPSHOT_PATH` | Blob pathname of the database snapshot | `db/snapshot.tar.gz` |
| `BLOB_READ_WRITE_TOKEN` | Injected by the Vercel Blob integration; required for `blob` mode | — |
| `LOCAL_DATA_DIR` | Local snapshot directory | `./data/pglite` |
| `QR_CHALLENGE_SECRET` | ≥32 chars; rotating it invalidates every live code | required |
| `SESSION_TTL_SECONDS` | Absolute session lifetime | `2592000` (30 days) |
| `PENDING_ATTEMPT_TTL_SECONDS` | How long a scanned attempt stays completable | `120` |
| `QR_ACCEPTANCE_OVERLAP_SECONDS` | Grace window after a code rotates | `3` |
| `DISPLAY_TIMEZONE` | Timezone for day boundaries and formatting (storage is UTC) | `Asia/Tehran` |
| `COOKIE_SECURE` | `Secure` cookie attribute; `false` only for local HTTP | `true` in production |
| `TRUST_FORWARDED_FOR` | Trust `x-forwarded-for` for client IP | `false` |
| `BOOTSTRAP_ADMIN_PASSWORD` | First-run admin password | `admin` |
| `CRON_SECRET` | Bearer value required by `/api/v1/cron/cleanup` | — |

The QR rotation interval lives in the database and is managed in the admin UI — it is not
an environment variable.

Note: `lib/config.ts` fails closed. `STORAGE_MODE=blob` without a Blob token refuses to
start rather than silently falling back to ephemeral storage.

---

## 5. Why challenges are not stored

A challenge is derived, never persisted:

```
token = base64url(HMAC-SHA256(QR_CHALLENGE_SECRET,
        "qr1|" + display_id + "|v" + schedule_version + "|" + interval + "|" + interval_start))[0:32]
```

* the display polls once per second → **zero database writes**
* expiry is arithmetic, so there is no cleanup job for codes
* one displayed code serves every employee; scanning consumes nothing
* the previous interval is accepted for `QR_ACCEPTANCE_OVERLAP_SECONDS` after rotation
* revoking a display or rotating the secret invalidates outstanding codes instantly

**Documented deviation from the original plan:** the HMAC message also includes the
schedule version and interval. With only `(display_id, interval_start)` an old code could
survive an interval change when the two schedules share a boundary (5s→15s at a common
multiple of 15), which would contradict the acceptance criterion "changing the interval
invalidates earlier tokens". Folding the schedule into the message makes that guarantee
exact and costs nothing.

There is no unauthenticated way to read the current code: `GET /api/v1/display/challenge`
requires the display credential, so codes cannot be harvested remotely.

---

## 6. Concurrency and durability semantics

* **Optimistic, not locking.** The snapshot is replaced with a conditional write
  (`ifMatch: etag`). If another instance wrote first, `BlobPreconditionFailedError` is
  raised, the instance is discarded, the snapshot is reloaded and the whole request is
  retried — at most twice. After that the client gets **409 `write_conflict`**, never a
  false success.
* **Warm-instance freshness.** Every request re-reads the snapshot ETag (1 simple Blob
  operation). If it moved, the cached instance is dropped and reloaded, so a warm instance
  does not serve stale reads.
* **One transaction per mutation.** Write handlers run inside a single Postgres
  transaction; a business error (bad password, last-admin protection) rolls back and is
  never persisted.
* **Warm-instance saturation.** Writes on one instance are serialised, so a second request
  waits rather than fighting over the same dump.
* **Data-loss surface.** Anything not yet uploaded dies with the instance. Handlers always
  save before responding.
* **Snapshot size and write amplification.** A PGlite datadir carries the full Postgres
  catalog and template databases, so the gzipped snapshot has a **baseline of ≈4.6 MB** even
  when it holds only one administrator; application rows add kilobytes. Every mutation
  re-uploads that whole object. Blob bills *operations*, not bytes, so the advanced-operation
  budget is unaffected, but each write is ≈4.6 MB of egress and one CDN upload — measured, not
  estimated. The plan's "tens of kilobytes" assumption did not hold; this is the first thing
  to replace if the demo grows (see §12).
* **Snapshot growth.** Postgres does not shrink pages when rows are deleted, so the snapshot
  grows slowly from the baseline. A manual re-dump/restore is the documented maintenance
  step. Practical ceiling for this scope: a few megabytes of *data* on top of the baseline.
* **Cold starts (measured).** Local production build, file storage, 4.6 MB snapshot: first
  request after a restart **0.59 s** (snapshot inflate + PGlite boot), warm request **13 ms**,
  and a first-ever boot **2.2 s** (migrations, admin seed, initial upload). Vercel adds blob
  download and cold-start overhead on top; those numbers are **not** verified here.

---

## 7. Free-tier budget (Vercel Hobby)

| Resource | Hobby | Meaning here |
| --- | --- | --- |
| Function invocations | 1M / month | Not a constraint |
| Active CPU | 4 CPU-h / month | scrypt + PGlite boot dominate; keep the parameter set sane |
| Blob storage | 1 GB | Snapshot is well under a megabyte |
| Blob simple ops | 10,000 / month | One `stat` per request + snapshot downloads on cold start |
| **Blob advanced ops** | **2,000 / month** | **The binding constraint** |
| Cron jobs | 1, daily only | Cleanup only; everything else is time-derived |

A scan costs **two** advanced operations: one to persist the attempt, one to persist the
event. Admin edits cost one each, as do logins and password changes. A new browser also
spends one write the first time it visits `/auth/csrf` (it gets a two-hour flow binding), and
signing in after a scan adds the login write. That is roughly **800–1,000 scans per month**
before the budget is gone — fewer if admins edit a lot or everyone signs in on a new phone.

Because of that budget, the schema never writes on a timer: no challenge rows, no
per-request session touch, no audit-log table, in-memory rate limits instead of
database-backed ones. Usage resets monthly and Hobby cannot buy overage.

### Licensing

Vercel's Hobby plan is for **non-commercial personal use**. A demo used for company
business, or deployed for an employer, requires Pro. Keep this deployment personal and
non-commercial, or upgrade.

---

## 8. Security notes

* **Passwords**: `node:crypto` scrypt, per-password salt, timing-safe comparison, versioned
  `scrypt$N$r$p$salt$hash` format. Unknown usernames burn comparable CPU so login timing
  does not leak existence.
* **Sessions**: 32 random bytes, only `sha256(token)` is stored; HttpOnly, SameSite=Lax,
  `Secure` when `COOKIE_SECURE=true`, absolute 30-day expiry mirrored in the cookie.
  Logins rotate the session; password changes and resets revoke the other sessions;
  deactivation revokes all of them.
* **CSRF**: double-submit token. The `qa_csrf` cookie is **HttpOnly** and the value is
  returned by `GET /api/v1/auth/csrf`, then echoed in an `x-csrf-token` header — so page
  script cannot read the cookie, and cross-site requests cannot include the header. Every
  mutation also validates `Origin` (or `Referer`) against `PUBLIC_BASE_URL`.
* **Rate limits**: in memory, per instance (20 logins/minute/IP, 10 display activations).
  They reset on cold start and are not shared — an accepted weakening because a
  database-backed counter would cost an advanced Blob operation per attempt.
* **Headers**: HSTS, `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`, a self-only CSP,
  and `Referrer-Policy: no-referrer` on `/scan` and `/display`. All API responses are
  `no-store`.
* **Secrets never logged**: passwords, session tokens, QR tokens and display credentials
  are not written to logs; the database layer logs only sizes and timings.
* The snapshot Blob is written with `access: 'private'` — a public URL would expose the
  whole database.

---

## 9. API

Full contract: [`docs/openapi.yaml`](docs/openapi.yaml). Prefix `/api/v1`; JSON dates are
RFC 3339 UTC; errors always carry `{ error: { code, message, request_id } }`.

```
GET    /health
GET    /auth/csrf                     establish browser flow + CSRF token
POST   /auth/login                    rotate session, resume pending scan
POST   /auth/logout
GET    /auth/me
POST   /auth/change-password
GET    /admin/users                   POST /admin/users
PATCH  /admin/users/{id}              POST /admin/users/{id}/reset-password
GET    /admin/settings                PATCH /admin/settings
POST   /admin/display/activate        POST /admin/display/revoke
GET    /display/challenge             display credential only
POST   /attendance/attempts           exchange a scanned code
POST   /attendance/attempts/{id}/complete
GET    /attendance/me
GET    /admin/attendance
POST   /cron/cleanup                  CRON_SECRET bearer
```

Status codes: 400 malformed, 401 unauthenticated, 403 forbidden, 404 not found (also used
for a stolen attempt id without its browser binding), 409 conflicting edit or exhausted
write retry, 410 expired code/attempt, 429 rate limited.

---

## 10. Database

Drizzle schema in `lib/db/schema.ts`, SQL migrations in `drizzle/`, embedded at build time
into `lib/db/migrations.generated.ts` by `npm run migrations:embed` (run automatically by
`npm run build`).

`users`, `sessions`, `browser_flows`, `settings`, `displays`, `attendance_attempts`,
`attendance_events`. **There is no `qr_challenges` table** — challenges are derived.
`attendance_events.attempt_id` is unique: it is the idempotency key that makes completing a
scan twice impossible.

Retention (daily cron + inline cleanup inside existing write transactions): sessions are
purged 30 days after expiry/revocation, browser flows 1 day after expiry, uncompleted
attempts 1 day after expiry. Attendance history is never touched.

Changing the schema:

```bash
# edit lib/db/schema.ts
npm run migrations:generate     # writes drizzle/000N_*.sql
npm run migrations:embed        # inlines it into migrations.generated.ts
```

Boot applies pending migrations to whatever snapshot it loads, so a deploy that adds a
migration upgrades the existing database in place on first use.

---

## 11. Tests

```bash
npm test          # Vitest: unit + PGlite integration (38 tests)
npm run test:e2e  # Playwright: real browser journeys against a dev server
```

* `tests/unit` — challenge derivation/expiry/overlap, timezone day boundaries, scrypt,
  rate limiting.
* `tests/integration` — snapshot round-trip, conditional-write conflict and retry, "never
  report success for a lost write", migrations applied once, plus the whole attempt
  lifecycle: one event per attempt, idempotency, flow binding, expiry, several employees on
  one code, interval change invalidation, cold-instance durability.
* `tests/e2e` — admin sign-in and user creation, interval change persistence, display
  provisioning, first scan with sign-in, later scans without sign-in, role isolation at page
  and API level, CSRF rejection, deep links and JSON 404s.

The Playwright suite drives a real Chromium at 127.0.0.1:3100 with a disposable snapshot
directory (`data/e2e`).

---

## 12. Deploying to Vercel (Hobby, $0)

1. Push this repository (private by default). `.env`, `data/`, `.next/` are git-ignored.
2. Create a Vercel project from it. **Create a Blob store** and connect it to the project so
   `BLOB_READ_WRITE_TOKEN` is injected.
3. Set production environment variables: `PUBLIC_BASE_URL`, `QR_CHALLENGE_SECRET`,
   `CRON_SECRET`, `BOOTSTRAP_ADMIN_PASSWORD`, `COOKIE_SECURE=true`, `STORAGE_MODE=blob`,
   `TRUST_FORWARDED_FOR=true`.
4. Deploy. The first request creates the snapshot, runs migrations and seeds `admin`.
   Boot is idempotent — a redeploy never reseeds or resets a password.
5. **Preview deployments must not share production state**: give them a different
   `SNAPSHOT_PATH`, or no Blob token at all so they fail closed.
6. Verify on the preview: cookie flags, CSRF, role separation, interval change, and
   durability across a cold start (write, wait for eviction, read back).
7. Promote, then activate the display on the monitor and test the real phone flow. Vercel
   Authentication (if enabled) must not intercept `/scan` or `/login`.

`vercel.json` pins the function region, the daily cleanup cron and the security headers.

### Upgrade path

If write volume or concurrency outgrow the snapshot, replace `withDatabase` with a
`postgres.js`/Neon adapter. The Drizzle schema, migrations, queries and handlers are
unchanged. Do not run both adapters at once, and test the switch before trusting it.

---

## 13. Implementation decisions worth knowing

* **Attempts are recorded before login.** A first-time employee exchanges the QR for a
  pending attempt (2-minute window) before typing credentials, so the scan is not lost.
  Login completes it automatically.
* **A scan is a POST, a QR view is a GET.** Opening `/scan` records nothing; the CSRF
  protected `POST /attendance/attempts` does. The challenge is stripped from the address
  bar with `history.replaceState` so a refresh cannot submit a second event.
* **Activating a display signs the admin out** in the same request, because the monitor
  must not keep admin rights. Revoke the display from another browser to reclaim it.
* **`recorded_at` is the exchange time**, `committed_at` is the insert time. Phone clocks
  are never read.
* **Day boundaries** are calendar days in `DISPLAY_TIMEZONE`, translated to
  `[start, nextStart)` UTC ranges, so a Tehran day is exactly one day.
* **Local storage uses the same dump/load path as production** (`./data/pglite/snapshot.tar.gz`)
  rather than a real on-disk datadir, so snapshot and concurrency bugs surface locally
  instead of only on Vercel.
* **Migrations are embedded** at build time, because a serverless bundle cannot be relied on
  to read `drizzle/` from disk.
* **No `Entry`/`Exit` vocabulary anywhere.** The UI says "Attendance event" and shows no
  derived duration.

---

## 14. Known limitations

* Roughly 800–1,000 scans per month on the free tier (see §7).
* The snapshot has a ≈4.6 MB baseline, so each mutation uploads that much (§6).
* Rate limiting is per instance and resets on cold start.
* A 5-second rotation is fraud deterrence, not proof of physical presence — a photo of a
  live code within its rotation window still works.
* One company, one entrance in this version. The display identity exists so more can be
  added without changing event identity.
* Warm instances serve reads revalidated only by ETag; a request cannot see writes that are
  mid-flight on another instance until that write lands.
* Not verified in this environment: real Vercel Blob behaviour (`ifMatch`,
  `BlobPreconditionFailedError`, private-store reads) — the adapter is written against the
  SDK types and covered only by the in-memory fake. No deployment was performed.
