# qr-attendance — implementation and deployment plan (Vercel, zero-cost stack)

## Handoff instruction

Implement a project named `qr-attendance` in a dedicated workspace using **Next.js 16 (App Router), React 19, TypeScript, PGlite (WASM Postgres) and Vercel Blob** for storage. The application must run entirely on the **Vercel Hobby plan at $0**, with **no third-party database account**: the database is a real Postgres datadir produced by PGlite and persisted as a snapshot object in Vercel Blob. Inspect existing files and applicable AGENTS.md instructions first. Deliver a working application, schema and migrations, setup scripts, tests, and a README. Make routine implementation decisions independently and document them. Do not build entry/exit inference or payroll functionality.

This revision replaces the earlier Go + Angular + SQLite/Turso stack. The previous plan is preserved in `IMPLEMENTATION_PLAN.original.md`; that stack is no longer in scope. No Go, no Angular, no local SQLite file, no Turso/libSQL, no hosted Postgres account.

Current authorization: update this Markdown plan only. Do not create a repository, provision cloud resources, or deploy from the current attendance-device workspace. The user will create a separate workspace for implementation and publication. When the user authorizes publication there, create a GitHub repository named `qr-attendance` in their confirmed account and deploy to Vercel. Include only this project's sources; exclude the unrelated device SDK experiments in the original workspace.

This document is a plan only; no application has been implemented. Recheck tool versions and instructions during implementation.

## 1. Product scope

Build a small-company attendance collection mechanism and the first version of an employee portal. Employees use their phone's normal camera to scan a QR displayed at the office entrance. The QR opens a browser page, identifies the employee through their portal session, and automatically records a raw attendance event. No installed mobile app is required.

Required features:

- Entrance display page with a QR refreshed every five seconds by default.
- Admin panel to create and manage pre-registered users and configure the QR refresh interval.
- Employee login with a persistent browser session.
- Employee attendance history showing only their own events.
- Admin attendance history showing all employees' events.
- Raw events containing an employee identity and server-assigned timestamp. Never infer entry, exit, shift duration, lateness, or payroll consequences.
- Attendance persistence that survives function cold starts and redeploys **without a paid or third-party database**: a database snapshot stored in Vercel Blob.

Out of scope: public self-registration, native apps, MAC identification, passkeys, location or office-network enforcement, sophisticated forwarding detection, offline attendance, power-outage handling, email/SMS delivery, salary receipts, and multi-tenant ERP integration. Preserve stable employee identifiers for later ERP mapping.

Assume one company and one entrance display for this version. Use a display identifier so additional displays can be added later without changing event identity.

## 2. Stack and runtime architecture

One deployable unit, one origin, one language.

| Layer | Choice | Notes |
| --- | --- | --- |
| Framework | Next.js 16 App Router, React 19, TypeScript strict | UI and API in one project; Vercel-native |
| API | Route handlers under `app/api/v1/**` | Node.js runtime (`export const runtime = 'nodejs'`); not Edge |
| Database engine | PGlite `@electric-sql/pglite` (WASM build of Postgres) | Real Postgres semantics, transactions, `timestamptz`, no server process |
| Persistence | PGlite datadir tarball in Vercel Blob | Snapshot load on boot, conditional-write save after mutations (see §3) |
| Query layer | Drizzle ORM + drizzle-kit migrations | Typed schema; migrations checked in |
| Styling | Tailwind CSS 4 + small component set | Dark/teal theme, reduced-motion respect |
| QR rendering | `qrcode` (client-side canvas/SVG) | No third-party content on the scan route |
| Passwords | `node:crypto` `scrypt` | No native module; avoids build/runtime native deps |
| Tests | Vitest (unit + PGlite integration), Playwright (e2e) | Blob adapter covered by a fake-store round-trip test |
| Hosting | Vercel Hobby, Node functions, Vercel Cron | Free tier only; see §12 budget |

Rationale for leaving Go/Angular: Vercel's Go runtime is Beta and cannot host durable storage, so a Go service plus a separate static Angular build reproduced a two-artifact, two-build deploy. A single Next.js app removes the split, and PGlite gives SQLite-like installation simplicity with Postgres semantics that survive a future move to a hosted database.

Constraints that shape the design:

- Node.js functions only. PGlite is WASM and requires the Node runtime, and `next.config.ts` must trace the wasm/pg assets into the function bundle (`outputFileTracingIncludes`). No Edge runtime route touches the database.
- No background loops. All rotation, expiry and cleanup is derived from server time or triggered by requests/cron.
- No durable local filesystem. Anything that must outlive a request goes through the Blob snapshot adapter; `/tmp` is used only for scratch work inside a single invocation.
- Every handler is stateless in principle; per-instance caching is an optimization with an explicit staleness check (§3.4).
- Server-supplied timestamps only. Never accept employee identity or time from the client.

## 3. Storage architecture: PGlite with a Blob snapshot

This is the part that replaces the whole database tier. It is the highest-risk area of the project and must be validated first (§13 step 1).

### 3.1 Why a snapshot

Vercel functions have no durable disk, and the Hobby plan includes only Blob storage (1 GB, 10,000 simple operations and 2,000 advanced operations per month). PGlite can dump and load a complete Postgres datadir:

- `await PGlite.create({ dataDir: 'memory://', loadDataDir: tarball })`
- `const tarball = await db.dumpDataDir()`

So the database is "one file" — a tarball object at a fixed path (`db/snapshot.tar.gz` by default, configurable via `SNAPSHOT_PATH`) — which is what was asked for, minus the illusion of a writable local disk.

### 3.2 Adapter interface

`lib/db/client.ts` exposes one function used by every handler:

```ts
withDatabase<T>(fn: (db: Database) => Promise<T>): Promise<T>
```

It must be the only place that knows about Blob. A later move to a hosted Postgres is a second implementation of the same function, not a rewrite (§3.7).

### 3.3 Read and write path

Boot (per instance, lazily on first request):

1. `head(SNAPSHOT_PATH)` to read the current ETag (1 simple operation).
2. If no snapshot exists, create a fresh PGlite instance at `memory://`, run migrations, seed the bootstrap admin, and save.
3. Otherwise download the tarball and `PGlite.create({ dataDir: 'memory://', loadDataDir })`.
4. Cache the instance and its ETag in module scope for the lifetime of the warm instance.

Mutating request (one transaction, then one save):

1. Re-validate freshness: `head()` and compare the ETag with the cached one. If it changed, discard the cached instance and reload.
2. Run the handler's work inside `db.transaction(...)`.
3. `dumpDataDir()` and `put(SNAPSHOT_PATH, tarball, { allowOverwrite: true, ifMatch: cachedEtag, cacheControlMaxAge: 60 })`.
4. On `BlobPreconditionFailedError`, discard the instance, reload, and **retry the whole request at most twice**. Surface a 409 with a stable error code if retries are exhausted — never report success for a write that did not land.
5. Serialize saves per instance with a single-flight mutex so one instance never dumps concurrently.

Pure reads (GET handlers) do not save. They may still `head()` to keep reads fresh; that is 1 simple operation.

### 3.4 Accepted semantics and failure modes

- **Optimistic concurrency, not locking.** Two instances writing simultaneously cannot corrupt the snapshot: the second conditional write fails and retries against the newer snapshot. This prevents silent data loss but can turn a request into a 409 under contention. Document it.
- **Warm-instance staleness.** Without a `head()` on every request, a warm instance could serve a slightly stale read. Accept 1 simple operation per request to revalidate; if that budget becomes a problem, revalidate only on mutating requests and accept bounded read staleness.
- **Write amplification.** Each mutating request uploads the whole datadir. Expect tens of kilobytes for this scope; state the practical ceiling (a few megabytes) and that the adapter is the first thing to replace if the demo grows.
- **Operation budget.** Every mutation costs exactly one advanced operation, plus metadata reads. See §12 for the arithmetic and the documented limits.
- **Cold starts.** Boot costs a download plus PGlite start (order of hundreds of milliseconds). Measure it; do not add speculative caching complexity before measuring.
- **Data loss surface.** Whatever has not been saved is lost with the instance. Keep transactions short and save before responding.

### 3.5 Write-budget design rules

The free tier allows 2,000 advanced operations per month, so the schema must not write on a schedule:

- **QR challenges are never persisted** (§6). They are derived with HMAC from `(display_id, interval_start)` and verified by recomputation. This is the most important decision in this revision: a persisted challenge row every five seconds would consume the monthly write budget in a few hours.
- Sessions are written on login, logout, password change and revocation only — not on every request.
- Rate-limit counters are in memory per instance (§5), because a database write per login attempt would exceed the budget. This is a documented weakening: distributed brute-force protection is best-effort.
- Cleanup of expired sessions/flows/attempts runs opportunistically inside an existing transaction and from one daily cron, never as its own write storm.
- One scan costs at most two advanced operations (attempt creation, attempt completion). Budget roughly 800–1,000 scans per month, fewer if admins also edit data. State this in the README.

### 3.6 Schema-level consequences

- Use `timestamptz` for time columns and RFC 3339 in JSON.
- Keep the datadir small: no audit-log tables, no per-request logging tables, no soft-delete history beyond what §10 requires.
- Deleting rows shrinks nothing immediately (Postgres keeps pages); the snapshot grows. Document that the snapshot grows slowly and that a manual re-dump/restore is the maintenance step.

### 3.7 Upgrade path to a hosted database

If write volume or concurrency outgrow the snapshot, replace `withDatabase` with a `postgres.js`/Neon adapter. The Drizzle schema, migrations, queries and handlers stay unchanged. Do not promise this works without testing it, and never mix both adapters at once.

## 4. Identity, users, and roles

Each user has a stable internal ID, a unique employee code, a unique normalized username, a display name, a password hash, a role (admin or employee), and an active flag. User IDs and employee codes remain stable even if a username changes. Do not allow hard deletion of users with historical attendance.

Seed the initial administrator only on first initialization:

- Username: admin
- Password: admin
- Role: admin

Never store the password in plaintext, reseed it over an existing account, or reset it on restart. Support changing it from the admin UI. Show a clear default-password notice until changed; do not require a blocking forced-change flow for the initial local prototype. Document changing it before exposing the server publicly. Provide an optional bootstrap password environment variable.

Admin capabilities:

- Create users; set username, employee code, display name, password, role, and active status.
- Edit user details and reset passwords.
- Deactivate users and revoke their sessions; password resets also revoke existing sessions.
- Change own password and log out.
- Prevent accidental removal/deactivation/demotion of the last active administrator.
- Configure QR refresh interval and provision/revoke the entrance display.
- View all attendance events with employee and date filters.

Employees can log in, log out, change their own password, and view only their own history. Do not return password hashes, session secrets, or display credentials in user-list responses.

## 5. Browser sessions and security

- Hash passwords with `node:crypto` `scrypt` (established parameters, per-password salt, timing-safe comparison). Never implement cryptography manually.
- Use cryptographically random opaque session tokens (`randomBytes(32)`). Store only `sha256(token)` server-side with user ID, creation time, expiry, and revocation metadata.
- Initial session lifetime: 30 days absolute, configurable. Cookie expiry and server expiry must agree.
- Cookie attributes: HttpOnly, SameSite=Lax, Path=/, and Secure for HTTPS. Set cookies through `cookies()` in the route handler. Do not store authentication tokens in localStorage.
- Permit Secure=false only through an explicit local HTTP development setting. Default to secure cookies.
- Rotate the session on successful login. Reject inactive users even if they hold an otherwise valid session.
- Protect state-changing endpoints with a double-submit CSRF token plus an `Origin`/`Referer` check against `PUBLIC_BASE_URL`. SameSite alone is insufficient. Login and automatic attendance submission are equally protected.
- Enforce permissions on the server. UI guards are convenience only.
- Rate-limit login attempts and display provisioning **in memory, per instance** (fixed window, e.g. 20 logins/minute per client IP). Document that counters reset on cold start and are not shared between instances; this is accepted because database-backed counters would consume the Blob write budget. Client IP must come from the platform's forwarded header (`x-forwarded-for`, first hop) with an explicit trust setting, never from the socket address alone.
- QR landing GET requests never write attendance. The landing flow makes an automatic authenticated POST; no confirmation button.
- Do not log passwords, raw session credentials, QR tokens, or display secrets. Use HTTPS, a restrictive referrer policy (`no-referrer` on the scan route), and no third-party content there. Disable caching of authentication, scan and challenge responses (`Cache-Control: no-store`).
- Apply security headers in `next.config.ts` or a `headers()` rule: HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and a CSP allowing only self-hosted scripts and styles (adjust for inline styles).
- Future portal features such as salary receipts may require fresh authentication. Keep `authenticated_at` available; do not implement salary features now.

## 6. Display enrollment and QR generation

Do not expose an unauthenticated endpoint that reveals the current challenge: that would let anyone fetch codes remotely without viewing the display.

Provision a dedicated display identity through the admin panel. Flow: an admin opens the entrance page on the intended monitor and explicitly activates display mode; the server issues a separate restricted HttpOnly display cookie stored as a hash in `displays`. Log the admin out on that monitor afterward. The display cookie authorizes challenge retrieval only, never admin operations or employee identity. Provide an explicit revoke-display control.

### 6.1 Stateless challenges

The challenge token is derived, not stored:

```
token = base64url(HMAC-SHA256(QR_CHALLENGE_SECRET, "qr1|" + display_id + "|" + interval_start))[0:32]
```

- `interval_start = floor(server_now / interval) * interval`, in whole seconds.
- The display polls `GET /api/v1/display/challenge` about once per second; the server derives the token for the current interval and returns `qr_url`, `server_time`, `next_rotation`, `expires_at`, `qr_interval`, `schedule_version`. No database write occurs, and repeated polls naturally reuse the same token.
- The server never accepts a token it cannot recompute for the current or previous interval, so expiry is enforced by arithmetic rather than by rows.
- Acceptance overlap: 3 seconds, configured separately, implemented as accepting the previous interval while it is still within `interval + overlap`.
- Rotation interval: default 5 seconds, admin-settable from 3 to 60 seconds, stored in `settings` (a write only when changed).
- Changing the interval increments `schedule_version` and therefore changes derived tokens; outstanding unexchanged challenges become invalid without any cleanup. Already established pending attempts keep their own expiry.
- Revoking the display deactivates its credential, which invalidates polling immediately; rotating `QR_CHALLENGE_SECRET` invalidates every outstanding token at once and is the emergency lever.
- One displayed challenge works for many employees; nothing is consumed on first scan.

Because a forged token needs the secret and the exact display/interval pair, unpredictability is preserved without storage: the security property is "cannot be guessed without the server secret", which is what the earlier random-token design provided.

`{PUBLIC_BASE_URL}/scan?challenge={token}` is built only from validated configuration, never from a request `Host` or forwarded header.

Display UI: large high-contrast QR, refresh countdown, office/display label, connection state. Stop presenting a QR as usable when the server cannot be reached or the derived expiry has passed. Five-second rotation is fraud deterrence, not proof of physical presence.

## 7. Attendance scan and login flow

### Existing authenticated session

1. Camera detects the QR and the employee opens its URL in their normal browser.
2. The page reads the challenge, obtains a CSRF token, and POSTs `/api/v1/attendance/attempts`.
3. The server validates the challenge by recomputation, then records the attempt and browser-flow binding in one transaction (one advanced operation).
4. The page immediately POSTs `/api/v1/attendance/attempts/{id}/complete`.
5. The server resolves the employee exclusively from the session, inserts the event transactionally, and returns a receipt (one advanced operation).
6. Show employee name, recorded time, and today's events. No confirmation or entry/exit selection.

### No authenticated session

1. Exchange the still-valid QR for a pending attempt before asking the employee to log in.
2. Bind the attempt to an opaque preauthentication flow cookie. An attempt ID alone must not authorize completion.
3. Give the pending attempt a two-minute lifetime measured from exchange; later QR expiry does not invalidate it.
4. Show login while preserving the attempt server-side.
5. On successful login, rotate the session, retain the verified flow binding, and complete the pending attempt automatically before navigating to history.
6. If login finishes after the attempt expires, keep the employee logged in and ask them to rescan. Ordinary login records nothing.

Timestamps: `recorded_at` is the server time at successful challenge exchange; `committed_at` is when authentication and insertion finish. Never trust phone time. Pending attempts create no event until completed by an active authenticated user.

Clean the challenge from the address bar after exchange (history replace). Refreshing a receipt must not submit another event. Completion is idempotent per attempt: retries return the same event, protected by a unique constraint on `attempt_id` and one transaction. A new intentional scan may create another raw event; do not add rules that infer or suppress entry/exit behavior.

An invalid or expired challenge, expired attempt, missing binding, inactive user, unavailable server, or exhausted write retry must produce an explicit, actionable result. Never display success before the server confirms the insert.

## 8. Frontend routes and screens

| Route | Access | Behavior |
| --- | --- | --- |
| `/login` | Public | Username/password; resumes a valid pending attendance after success |
| `/scan` | Public landing | Exchanges the QR and completes automatically, or presents login |
| `/attendance` | Authenticated | Own raw events; today by default; date range and pagination |
| `/account` | Authenticated | Change own password and log out |
| `/admin/users` | Admin | User creation, edits, password resets, role/status management |
| `/admin/settings` | Admin | QR interval and display activation/revocation |
| `/admin/attendance` | Admin | All raw events; employee/date filters and pagination |
| `/display` | Provisioned display | Full-screen rotating QR, countdown, connection state |

Implementation notes: server components read through the same `withDatabase` path; client components own polling, the scan landing, and form state. Route protection is enforced in handlers and mirrored by layout-level redirects for UX. `no-store` on dynamic routes; `dynamic = 'force-dynamic'` where session cookies are read.

Design: polished responsive interface with the `qr-attendance` wordmark, consistent spacing and typography, restrained dark/teal theme, clear status indicators, subtle transitions respecting reduced-motion. The entrance display gets a large central QR and unmistakable connection state. Employee flows must work on narrow phones; the display must stay legible on a monitor. Use labels such as "Attendance event", never Check-in/Check-out. Handle loading, empty, expired-session, server-error and 409-conflict states explicitly.

## 9. REST API contract

Prefix `/api/v1`. JSON dates are RFC 3339 UTC. Errors carry a stable code, a user-facing message, and a request ID. Lists have bounded `page`/`page_size` and a total count. Date filtering is from-inclusive/to-exclusive.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/health` | Minimal health status, no secrets |
| GET | `/auth/csrf` | Establish browser flow as needed and return a CSRF token |
| POST | `/auth/login` | Authenticate; rotate session; preserve a valid pending flow |
| POST | `/auth/logout` | Revoke current session |
| GET | `/auth/me` | Current user and permissions |
| POST | `/auth/change-password` | Change own password; revoke other sessions |
| GET, POST | `/admin/users` | List and create users |
| PATCH | `/admin/users/{id}` | Edit details, role, active status |
| POST | `/admin/users/{id}/reset-password` | Reset password and revoke sessions |
| GET, PATCH | `/admin/settings` | Read/update QR rotation setting |
| POST | `/admin/display/activate` | Provision a restricted display cookie for this browser |
| POST | `/admin/display/revoke` | Revoke the display credential |
| GET | `/display/challenge` | Restricted display endpoint; derived QR URL and timing metadata |
| POST | `/attendance/attempts` | Validate challenge, bind attempt, return attempt ID and deadline |
| POST | `/attendance/attempts/{id}/complete` | Authenticated idempotent completion and receipt |
| GET | `/attendance/me` | Current employee's raw events |
| GET | `/admin/attendance` | All events with employee/date filters |
| POST | `/cron/cleanup` | Scheduled cleanup, guarded by `CRON_SECRET` |

Status codes: 401 unauthenticated, 403 forbidden, 400 malformed, 409 conflicting edit or exhausted write retry, 410 expired QR/attempt, 429 rate limited. Distinguish an unauthenticated pending attempt from an invalid attempt without leaking credentials. Publish the final contract as checked-in OpenAPI.

## 10. Database model

Postgres schema managed by drizzle-kit migrations, `timestamptz` columns, UTC storage, stable IDs.

- `users`: id, employee_code, username_normalized, display_name, password_hash, role, active, default_password_pending, created_at, updated_at.
- `sessions`: token_hash (PK), user_id, authenticated_at, created_at, expires_at, revoked_at.
- `browser_flows`: token_hash (PK), created_at, expires_at — binds pending scans before and after login.
- `settings`: singleton row with `qr_interval`, `schedule_version`, `updated_at`.
- `displays`: id, label, credential_hash, active, created_at, revoked_at.
- `attendance_attempts`: id, challenge_interval_start, display_id, browser_flow_hash, captured_at, expires_at, completed_user_id, completed_event_id.
- `attendance_events`: id, user_id, employee_code_snapshot, display_id, attempt_id (unique), recorded_at, committed_at.

There is no `qr_challenges` table: challenges are derived (§6). Attempts keep `display_id` and `interval_start` for auditability, both retained if the display is later removed.

Indexes: `(user_id, recorded_at, id)` for employee history, `(recorded_at, id)` for admin lists, plus expiry columns for cleanup. Historical events survive user deactivation, display revocation and cleanup. Purge expired sessions, flows and attempts on a documented retention schedule without touching history.

## 11. Configuration

Documented in `.env.example`; no secrets in the repository or in client bundles.

| Variable | Purpose |
| --- | --- |
| `PUBLIC_BASE_URL` | Canonical HTTPS origin used in QR URLs and origin checks |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token injected by the Blob store integration |
| `SNAPSHOT_PATH` | Blob path of the database snapshot, default `db/snapshot.tar.gz` |
| `STORAGE_MODE` | `file` for local PGlite at `./data/pglite`, `blob` for Vercel |
| `QR_CHALLENGE_SECRET` | ≥ 32 random bytes; rotating it invalidates all live tokens |
| `SESSION_TTL` | Default 30 days |
| `PENDING_ATTEMPT_TTL` | Default 2 minutes |
| `QR_ACCEPTANCE_OVERLAP` | Default 3 seconds |
| `DISPLAY_TIMEZONE` | Default `Asia/Tehran`; storage stays UTC |
| `COOKIE_SECURE` | `true` for HTTPS; explicit `false` only for local HTTP |
| `BOOTSTRAP_ADMIN_PASSWORD` | Optional first-run admin password |
| `CRON_SECRET` | Required header value for `/cron/cleanup` |
| `TRUST_FORWARDED_FOR` | `true` on Vercel; `false` locally |

`QR_REFRESH_INTERVAL` lives in the database and is managed in the UI. Removed from the previous plan: `LISTEN_ADDR`, `DATABASE_PATH`, `DATABASE_MODE`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.

## 12. Phone testing and deployment (Vercel Hobby, $0)

### Local testing

1. `npm ci && npm run dev` with `STORAGE_MODE=file`, `PUBLIC_BASE_URL=http://localhost:3000`, `COOKIE_SECURE=false`. PGlite writes `./data/pglite` (git-ignored).
2. Same-Wi-Fi test: run `next dev -H 0.0.0.0`, set `PUBLIC_BASE_URL=http://<LAN-IP>:3000`, allow the port through the host firewall. Suitable only for disposable test data over plain HTTP.
3. HTTPS tunnel (Cloudflare Quick Tunnel) when a realistic HTTPS test is needed before deploying: point `PUBLIC_BASE_URL` at the tunnel origin and set `COOKIE_SECURE=true`. Quick Tunnel hostnames change; a changed hostname means new cookies and re-provisioning the display.

### Free-tier budget (verified against Vercel docs)

| Resource | Hobby included | What it means here |
| --- | --- | --- |
| Function invocations | 1,000,000 / month | Not a constraint for a demo |
| Active CPU | 4 CPU-hours / month | scrypt and PGlite boot are the costs; keep hashing parameters sane |
| Function duration | 300 s max | Fine |
| Blob storage | 1 GB / month | Snapshot stays in the megabytes at most |
| Blob simple ops | 10,000 / month | Metadata reads and cache-miss downloads |
| Blob **advanced ops** | 2,000 / month | **The binding constraint**: one per mutating request |
| CDN requests | 1,000,000 / month | Fine |
| Cron jobs | 1 per project, **once per day only** (±59 min) | Cleanup runs daily; everything else must be time-derived |
| Deployments | 100 / day | Fine |

Document in the README: roughly 800–1,000 scans per month before the write budget is exhausted; a heavy demo day can burn a large share of it; usage resets monthly and Hobby cannot purchase overage. If the demo needs headroom, switch the adapter to a free hosted Postgres (§3.7) rather than paying.

Licensing constraint: the Hobby plan is restricted to **non-commercial personal use** under Vercel's fair-use guidelines. A demo used for company business, or deployed for the employer, requires Pro. State this plainly in the README and keep the demo personal and non-commercial.

### Publication sequence (only after authorization in the new workspace)

1. Confirm the GitHub and Vercel accounts and intended ownership. Default to a **private** repository unless the user asks for public.
2. Create `qr-attendance` containing application source, lockfile, migrations, tests, `.env.example`, this plan, and docs. Exclude `.env`, `data/`, `.next/`, and unrelated device SDK material.
3. Add `vercel.json`: Node function region close to the demo users, the daily cleanup cron, and security headers. Keep API and asset routes ahead of SPA behaviour (`app/**` handles deep links; `/api/v1` returns JSON 404s, never `index.html`).
4. Create the Vercel project from the repository, then create a **Blob store** so the integration injects `BLOB_READ_WRITE_TOKEN`.
5. Set production env vars: `PUBLIC_BASE_URL`, `QR_CHALLENGE_SECRET`, `CRON_SECRET`, `BOOTSTRAP_ADMIN_PASSWORD`, `COOKIE_SECURE=true`, `STORAGE_MODE=blob`, `TRUST_FORWARDED_FOR=true`.
6. First deploy initializes the snapshot, runs migrations and seeds the admin. Make boot idempotent and safe to rerun; never expose a public bootstrap endpoint.
7. Preview deployments must not write the production snapshot: give previews a distinct `SNAPSHOT_PATH`, or no Blob token at all so they fail closed instead of sharing state.
8. Verify on the preview: routing, cookie flags, CSRF, role separation, QR interval change, and **durability across cold starts** (scan, wait for eviction, reload and confirm the event persists).
9. Promote to production, then test the real phone flow on the `.vercel.app` hostname: activate the display on the monitor, first scan through login, subsequent scans without login. Vercel Authentication must not intercept `/scan` or `/login` for the demo device.
10. Report the verified links and every check that could not be performed. Do not claim physical-device testing if it did not happen.

No domain purchase is required; the assigned `*.vercel.app` host is determined at project creation. Do not promise a specific hostname.

## 13. Implementation sequence

1. **Spike first.** Prove the riskiest assumptions before any UI: PGlite boots inside a Vercel function (WASM traced into the bundle), `dumpDataDir()`/`loadDataDir` round-trips through Blob with `ifMatch`, a second writer reliably gets `BlobPreconditionFailedError`, and cold-start latency is measured. Abandon the snapshot design only if a spike check fails, and report the exact failure before choosing an alternative.
2. Scaffold Next.js + TypeScript + Tailwind, Drizzle config and schema; wire `withDatabase` with a `file` adapter and a `blob` adapter; add the snapshot round-trip test against a fake store.
3. Implement migrations, bootstrap admin, users, scrypt hashing, sessions, CSRF, permissions and user-management endpoints.
4. Implement login, account settings and admin user screens; verify employee/admin separation.
5. Implement settings, display provisioning, derived challenges and the full-screen display UI with countdown and connection state.
6. Implement browser-bound scan attempts, login continuation, automatic completion, receipts and raw event storage — including idempotency and retry-on-precondition-failure.
7. Implement employee and admin history with filters, timezone-aware display and pagination.
8. Add the daily cleanup route plus `CRON_SECRET`, opportunistic cleanup inside writes, and time-derived expiry everywhere.
9. Run Vitest and Playwright suites, then the phone workflow over LAN or tunnel. Write the README with the free-tier budget, cold-start behaviour, concurrency semantics and known limitations.
10. Only when authorized in that workspace, publish to GitHub and deploy to Vercel.

## 14. Acceptance criteria and verification

- A fresh snapshot seeds admin/admin exactly once; changing the password survives a cold start and survives dump/load.
- Admin can create, edit, deactivate, reset passwords, and change the QR interval. Non-admin direct API calls are rejected.
- Deactivation and password reset invalidate relevant sessions. Last-admin protection works.
- Unprovisioned browsers cannot fetch `/display/challenge`; a display credential cannot call admin APIs.
- The derived challenge is stable within one interval across repeated polls, changes at the boundary, is accepted during the configured overlap, and is rejected after it. Changing the interval invalidates earlier tokens without any cleanup write.
- Several employees can use the same displayed challenge; separate intentional scans remain independent raw events.
- A first-time scan survives login for up to two minutes and produces exactly one event using the exchange-time timestamp.
- Later scans in a valid session need no login. No confirmation step is added.
- Invalid or expired challenges and expired attempts create no event. Ordinary login creates no event.
- Retrying or concurrently completing one attempt returns one event. A stolen attempt ID without its flow binding cannot complete.
- Employees cannot read others' events or choose employee/timestamp in payloads. Admin filters and sees all.
- A QR GET alone creates no event; CSRF covers automatic submission and admin mutations.
- **Durability:** events, users and settings survive instance eviction and a redeploy, verified by writing, waiting out the instance, and reading back.
- **Concurrency:** two simultaneous mutating requests either both succeed (after retry) or the loser returns 409 — never a silent lost update, verified by a test that forces an ETag mismatch.
- **Budget:** a single scan costs at most two advanced operations; no code path writes on a timer; the cleanup cron performs one bounded write.
- UTC storage with Asia/Tehran day boundaries yields correct filters.
- The production build serves deep links (`/scan`, `/attendance`) and keeps API 404s as JSON.
- No secrets in client bundles or repository history; a public deployment has no active admin/admin password.
- `npm run build`, Vitest and Playwright pass; an end-to-end test covers login → scan → receipt → history, plus role isolation.

## 15. Documentation sources

Verify against current docs during implementation:

- [Next.js App Router](https://nextjs.org/docs/app) and [route handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers)
- [Next.js deployment on Vercel](https://nextjs.org/docs/app/building-your-application/deploying)
- [Vercel Hobby plan limits](https://vercel.com/docs/plans/hobby)
- [Vercel Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk) — `ifMatch` conditional writes and `BlobPreconditionFailedError`
- [Vercel Blob usage and pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing)
- [Vercel Cron jobs](https://vercel.com/docs/cron-jobs/usage-and-pricing) — Hobby is daily-only
- [Vercel fair use guidelines](https://vercel.com/docs/limits/fair-use-guidelines) — Hobby is non-commercial
- [PGlite API](https://pglite.dev/docs/api) — `PGlite.create`, `dumpDataDir`, `loadDataDir`, `memory://`
- [Drizzle ORM with PGlite](https://orm.drizzle.team/docs/connect-pglite)
- [Node.js crypto scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- [qrcode](https://www.npmjs.com/package/qrcode)
