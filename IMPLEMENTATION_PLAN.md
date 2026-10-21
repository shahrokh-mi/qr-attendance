> Repository note: This is the source implementation plan. Its old-workspace handoff restriction was superseded by the user's later explicit instruction to implement the plan in this separate repository. Local implementation is in progress; hosted storage and publication remain unvalidated.

# qr-attendance — implementation and deployment plan

## Handoff instruction

Implement a project named `qr-attendance` in a dedicated workspace using Go, Angular, local SQLite, and hosted SQLite-compatible storage for Vercel. Inspect existing files and applicable AGENTS.md instructions first. Deliver working backend and frontend, database migrations, setup scripts, tests, and a README. Make routine implementation decisions independently and document them. Do not build entry/exit inference or payroll functionality.

Current authorization: update this Markdown plan only. Do not create a repository, provision cloud resources, or deploy from the current attendance-device workspace. The user will create a separate workspace for implementation and publication. When the user authorizes publication there, create a GitHub repository named `qr-attendance` in their confirmed account and deploy the working application to Vercel. Include only this project's sources; exclude the unrelated device SDK experiments in the original workspace.

At the time this plan was written, no application had been implemented. The current repository now contains a local prototype; the Vercel/Turso hosted path is still unvalidated. Initial sandbox process execution failed with Windows error 1385, but a subsequent read-only check succeeded outside that sandbox. At planning time, Node and npm were on PATH; Go and the standalone sqlite3 CLI were not on PATH. No ancestor/workspace AGENTS.md was found in the checked paths. Recheck dependencies and instructions during implementation. No software was installed in this planning session; the selected Go SQLite driver will supply the embedded database engine when the application is implemented.

## 1. Product scope

Build a small-company attendance collection mechanism and the first version of an employee portal. Employees use their phone's normal camera to scan a QR displayed at the office entrance. The QR opens a browser page, identifies the employee through their portal session, and automatically records a raw attendance event. No installed mobile app is required.

Required features:

- Entrance display page with a QR refreshed every five seconds by default.
- Admin panel to create and manage pre-registered users and configure the QR refresh interval.
- Employee login with a persistent browser session.
- Employee attendance history showing only their own events.
- Admin attendance history showing all employees' events.
- Raw events containing an employee identity and server-assigned timestamp. Never infer entry, exit, shift duration, lateness, or payroll consequences.
- Durable attendance persistence: embedded SQLite locally and a hosted SQLite-compatible database on Vercel.

Out of scope: public self-registration, native apps, MAC identification, passkeys, location or office-network enforcement, sophisticated forwarding detection, offline attendance, power-outage handling, email/SMS delivery, salary receipts, and multi-tenant ERP integration. Preserve stable employee identifiers for later ERP mapping.

Assume one company and one entrance display for this version. Use a display identifier so additional displays can be added later without changing event identity.

## 2. Technology and runtime architecture

- Backend: a currently supported stable Go release, REST JSON API, layered handlers/services/repositories, and SQL migrations. Pin dependencies in go.mod/go.sum.
- Frontend: a currently supported stable Angular release with compatible Node.js LTS and TypeScript. Use Angular routing, standalone components, forms, and a maintained QR rendering package. Pin dependencies and commit the lockfile.
- Local database: embedded SQLite through a maintained Go driver. Prefer a pure-Go driver for straightforward Windows setup; verify current support before choosing it. Use foreign keys, suitable indexes, a busy timeout, and WAL where appropriate for local SQLite. Keep write transactions short.
- Hosted database: plan for Turso/libSQL using a supported remote Go client. Verify current driver support, transactions, and build compatibility with Vercel early, before committing to the driver. Never use a local database file, an embedded replica, or /tmp as durable storage in a function. Do not silently substitute a different database if this integration proves unsuitable; document the issue and settle the alternative with the user.
- Keep SQL and migrations compatible with both local SQLite and hosted libSQL; isolate connection/driver differences behind a repository layer. Run integration tests against both before release. Local filesystem pragmas must not be applied blindly to remote connections.
- Local mode uses a long-running Go server with a persistent database file. Hosted mode uses stateless Go HTTP handlers on Vercel Functions with the external database. Store sessions, browser flows, QR schedules, challenges, and attempts in the database, never solely in process memory. Enforce concurrency through database constraints and transactions.
- For local built mode, Go serves Angular assets and /api/v1/* from one origin. On Vercel, serve built Angular assets statically and route /api/v1/* to the Go function handler under the same origin. Keep the same application router behind both entry points. Serve index.html for Angular deep links, but never use SPA fallback for unknown API routes or missing assets.
- During active frontend development, Angular can run on port 4200 and proxy /api to Go on port 8080. Frontend API URLs must be relative, never hardcoded to localhost.
- Keep credentials, database files, and runtime logs out of source control and out of the web-served directory.

SQLite needs no separate server installation. First check Go, Node, npm, and any existing sqlite3 CLI. The Go driver supplies the database engine. Install a standalone SQLite CLI only if useful for diagnostics, and document the distinction. Do not let an optional CLI block implementation.

## 3. Identity, users, and roles

Each user has a stable internal ID, a unique employee code, a unique normalized username, a display name, a password hash, a role (admin or employee), and an active flag. User IDs and employee codes remain stable even if a username changes. Do not allow hard deletion of users with historical attendance.

Seed the initial administrator only on first initialization:

- Username: admin
- Password: admin
- Role: admin

Never store the password in plaintext, reseed it over an existing account, or reset it on restart. Support changing it from the admin UI. Show a clear default-password notice until changed; do not require a blocking forced-change flow for the initial local prototype. Document changing it before publicly exposing the server. Provide an optional bootstrap password environment variable for deployments.

Admin capabilities:

- Create users; set username, employee code, display name, password, role, and active status.
- Edit user details and reset passwords.
- Deactivate users and revoke their sessions; password resets also revoke existing sessions.
- Change own password and log out.
- Prevent accidental removal/deactivation/demotion of the last active administrator.
- Configure QR refresh interval and provision/revoke the entrance display.
- View all attendance events with employee and date filters.

Employees can log in, log out, change their own password, and view only their own history. Do not return password hashes, session secrets, or display credentials in user-list responses.

## 4. Browser sessions and security

- Hash passwords using an established password-hashing library and suitable parameters. Never implement cryptography manually.
- Use cryptographically random opaque session tokens. Store only token hashes server-side, with user ID, creation time, expiry, and revocation metadata.
- Initial session lifetime: 30 days absolute, configurable through server configuration. Persistent cookie expiry and server expiry must agree. Reauthentication after expiry is expected.
- Cookie attributes: HttpOnly, SameSite=Lax, Path=/, and Secure for HTTPS. Do not store authentication tokens in localStorage.
- Permit Secure=false only through an explicit local HTTP development setting. Default to secure cookies for HTTPS tunnel/deployment use.
- Rotate the session on successful login. Reject inactive users even if they have an otherwise valid session.
- Protect state-changing endpoints against CSRF, including login and automatic attendance submission. Use server-validated CSRF tokens and origin checks suitable for the single-origin architecture; SameSite alone is insufficient.
- Enforce permissions on the server. Angular route guards are convenience only.
- Rate-limit login attempts and display provisioning. Use parameterized queries and bounded input validation.
- QR landing GET requests never write attendance. The Angular landing flow makes an automatic authenticated POST; no confirmation button is required.
- Do not log passwords, raw session credentials, QR tokens, or display secrets. Use HTTPS, a restrictive referrer policy, and no third-party content on the scan route. Disable caching of authentication, scan, and challenge responses.

Future portal features such as salary receipts may require fresh authentication while keeping attendance convenient. Keep authentication timestamps available for that later policy; do not implement salary features now.

## 5. Display enrollment and QR generation

Do not make an unauthenticated public API that reveals the current challenge: that would let anyone fetch attendance codes remotely without viewing the display.

Provision a dedicated display identity through the admin panel. Suggested flow: an admin opens the entrance page on the intended monitor and explicitly activates display mode; the server issues a separate restricted HttpOnly display cookie. Log the admin account out on that monitor afterward. The display cookie authorizes challenge retrieval only, never admin operations or employee identity. Document that logging out the admin does not revoke the separately provisioned display; provide an explicit revoke-display control.

The server issues unpredictable random challenge tokens and stores their hashes, display association, issuance time, expiry, and schedule/version. Tokens are temporary visible challenges, not employee credentials or permanent signing secrets.

QR contents:

`{PUBLIC_BASE_URL}/scan?challenge={opaque-token}`

PUBLIC_BASE_URL is validated explicit configuration. Never build QR URLs from an untrusted Host or forwarded header. The base URL must be reachable by the phone and must never be localhost for phone testing.

Timing rules:

- Default rotation interval: 5 seconds. Admin can set an integer from 3 through 60 seconds.
- Acceptance overlap: 3 seconds, configured server-side separately from rotation. Thus a token normally lives for rotation interval + 3 seconds.
- The server is authoritative for rotation and expiry; the display uses server timing metadata rather than extending validity with its own clock.
- Use one token per display per server-defined interval; polling or reloading the display must not continuously mint extra current tokens. Creation must be safe under concurrent requests.
- The display polls its authorized endpoint approximately once per second and changes the QR only when the server returns a new challenge. Include server time, next rotation, and expiry in the response. Avoid SSE/WebSocket requirements for this version.
- When admin changes the interval, invalidate the old schedule and outstanding unexchanged challenges, and start a new schedule. Already established pending attempts retain their own expiry.
- One displayed challenge can be used by multiple employees. Do not consume it globally on the first scan.
- Show a large high-contrast QR, refresh countdown, office/display label, and connection state. Stop presenting a QR as usable after it expires if the server cannot be reached.

Five-second rotation is a convenience/fraud-deterrence choice, not proof of physical presence. Live forwarding remains possible and is accepted for this scope.

## 6. Attendance scan and login flow

### Existing authenticated session

1. Camera detects QR and employee opens its URL in their normal browser.
2. Angular reads the challenge, obtains CSRF protection, and exchanges the challenge through POST /attendance/attempts.
3. Server validates the challenge and creates or returns a browser-bound attempt. The attempt stores the server's initial valid receipt time.
4. Angular immediately POSTs /attendance/attempts/{id}/complete.
5. Server resolves the employee exclusively from the session, inserts an event transactionally, and returns a receipt.
6. Show employee name, recorded time, and today's events. No extra confirmation or entry/exit selection.

### No authenticated session

1. Exchange the still-valid QR for a pending attempt before asking the employee to log in.
2. Bind the attempt to an opaque preauthentication flow cookie. A pending attempt ID by itself must not authorize completion.
3. Give the pending attempt a two-minute lifetime measured from exchange. QR expiration afterward does not invalidate that already established attempt.
4. Show login while preserving the attempt server-side.
5. On successful login, rotate the authentication session, retain the verified flow binding, and automatically complete the pending attempt before navigating to history.
6. If login finishes after the attempt expires, keep the employee logged in and ask them to rescan. Ordinary login without a pending attempt records nothing.

Timestamp decision for this prototype: recorded_at is the server time at successful challenge exchange. committed_at is when authentication and event insertion finish. Never trust phone-provided time. Pending attempts create no event until completed by an active authenticated user. Display the recorded_at value in the receipt and history.

Clean the challenge from the browser address bar after exchange. Refreshing a receipt must not submit another event. Make completion idempotent per attempt: retries return the same event. Concurrent completion is protected by a database constraint and transaction. A new intentional scan may create another raw event; do not add business rules that infer or suppress entry/exit behavior.

An invalid/expired challenge, expired attempt, missing browser binding, inactive user, or unavailable server must show an explicit actionable result. Never display success before the server confirms the insert. If the exchange never reached the server before QR expiry, request a fresh scan; do not backdate from the phone.

## 7. Frontend routes and screens

| Route | Access | Behavior |
| --- | --- | --- |
| /login | Public | Username/password; resumes valid pending attendance after success |
| /scan | Public landing | Exchanges QR and completes automatically or presents login |
| /attendance | Authenticated | Own raw events; today by default; date range and pagination |
| /account | Authenticated | Change own password and log out |
| /admin/users | Admin | User creation, edits, password resets, role/status management |
| /admin/settings | Admin | QR interval and display activation/revocation |
| /admin/attendance | Admin | All raw events; employee/date filters and pagination |
| /display | Provisioned display | Full-screen rotating QR and connection/countdown state |

Build a polished responsive interface with the `qr-attendance` wordmark, consistent spacing and typography, a restrained dark/teal visual theme, clear status indicators, and subtle transitions that respect reduced-motion preferences. Give the entrance display a large central QR, animated refresh countdown, and unmistakable connection state. Show a clear success receipt and a readable event list in the employee portal. Admin screens should favor legible tables, compact filters, and straightforward forms. Avoid unnecessary animation or charts that imply entry/exit or hours worked.

Employee flows must work on narrow phone screens; the display page must remain legible on a monitor. Attendance rows show employee identity where relevant, date/time, and event ID. Use labels such as Attendance event, never Check-in or Check-out. Handle loading, empty, expired-session, and server-error states. Use semantic controls and accessible contrast.

## 8. REST API contract

Prefix: /api/v1. JSON dates are RFC 3339 UTC. API errors have a stable code, a user-facing message, and request ID. Lists have bounded page/page_size parameters and total counts. Date filtering uses from-inclusive/to-exclusive instants. Do not accept employee identity or attendance timestamps from scan clients.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | /health | Minimal health status, no secrets |
| GET | /auth/csrf | Establish browser flow as needed and return CSRF token |
| POST | /auth/login | Authenticate; rotate session; preserve valid pending flow |
| POST | /auth/logout | Revoke current user session |
| GET | /auth/me | Current user and permissions |
| POST | /auth/change-password | Change own password; revoke other sessions |
| GET, POST | /admin/users | List and create users |
| PATCH | /admin/users/{id} | Edit details, role, active status |
| POST | /admin/users/{id}/reset-password | Reset password and revoke sessions |
| GET, PATCH | /admin/settings | Read/update QR rotation setting |
| POST | /admin/display/activate | Provision restricted display cookie on current browser |
| POST | /admin/display/revoke | Revoke display credential and active challenges |
| GET | /display/challenge | Restricted display endpoint; current QR URL and timing metadata |
| POST | /attendance/attempts | Validate challenge, bind attempt, return attempt ID and deadline |
| POST | /attendance/attempts/{id}/complete | Authenticated idempotent completion and receipt |
| GET | /attendance/me | Current employee's raw events |
| GET | /admin/attendance | All events with employee/date filters |

Use 401 for required authentication, 403 for denied permissions, 400 for malformed input, 409 for conflicting edits, 410 for expired QR/attempt, and 429 for rate limits. Distinguish an unauthenticated pending attempt from an invalid attempt without leaking credentials. Publish the final contract as OpenAPI or equivalent checked-in API documentation.

## 9. Database model

Use migrations, UTC timestamps, stable IDs, and explicit constraints. Suggested tables:

- users: id, employee_code, username_normalized, display_name, password_hash, role, active, default_password_pending, created_at, updated_at.
- sessions: token_hash, user_id, authenticated_at, created_at, expires_at, revoked_at.
- browser_flows: token_hash, created_at, expires_at; used to bind pending scans before and after login.
- settings: singleton QR refresh interval and current schedule version, updated_at.
- displays: id, label, credential_hash, active, created_at, revoked_at.
- qr_challenges: id, token_hash, display_id, schedule_version, interval_start, issued_at, expires_at. Unique display/schedule/interval tuple.
- attendance_attempts: id, challenge_id, browser_flow_id, captured_at, expires_at, completed_user_id, completed_event_id.
- attendance_events: id, user_id, employee_code_snapshot, display_id, attempt_id, recorded_at, committed_at. Unique attempt_id.

Index events by (user_id, recorded_at, id), and by (recorded_at, id) for admin lists. Sort with an ID tie-breaker. Historical events survive user deactivation, display revocation, and challenge cleanup. Design foreign keys and nullable/retained audit references accordingly; never delete attendance through expiry cleanup. Purge expired sessions, flow secrets, and temporary challenges/attempts on a documented retention schedule without breaking history references.

## 10. Configuration

Provide .env.example or equivalent documented configuration; do not assume Go automatically reads .env files unless implemented.

- LISTEN_ADDR: default 127.0.0.1:8080; LAN example 0.0.0.0:8080.
- PUBLIC_BASE_URL: canonical reachable origin used in QR URLs.
- DATABASE_PATH: default ./data/attendance.db outside static assets.
- DATABASE_MODE: sqlite for local development; libsql for hosted deployment.
- TURSO_DATABASE_URL and TURSO_AUTH_TOKEN: hosted database connection secrets, server-side only. Never expose them through Angular environment files or build output.
- COOKIE_SECURE: true for HTTPS; explicit false only for local HTTP development.
- SESSION_TTL: default 30 days.
- PENDING_ATTEMPT_TTL: default 2 minutes.
- QR_ACCEPTANCE_OVERLAP: default 3 seconds.
- DISPLAY_TIMEZONE: default Asia/Tehran; storage remains UTC.
- Optional bootstrap admin password and explicit trusted-proxy settings.

QR_REFRESH_INTERVAL is stored in the database and managed in the UI. Configure forwarded-header trust explicitly if needed; do not trust arbitrary clients. Generate QR URLs from PUBLIC_BASE_URL regardless.

## 11. Smartphone testing and deployment

On a phone, localhost means the phone itself. It cannot reach the PC's server using the PC's localhost URL.

### Option A: same Wi-Fi, quickest basic test

1. Run Go serving the built Angular app on 0.0.0.0:8080.
2. Find the PC's Wi-Fi IPv4 address with ipconfig; example 192.168.1.50.
3. Set PUBLIC_BASE_URL=http://192.168.1.50:8080 and explicit development COOKIE_SECURE=false. Restart as needed.
4. Allow the application/port through Windows Firewall for the private network only if required.
5. Open that exact address on the PC's display browser and on the phone. Use the same host consistently for login and scanning.
6. Keep both devices on a network that permits communication; guest Wi-Fi/client isolation, VPN routing, and IP changes can prevent access.

This is suitable for disposable local test credentials on a trusted network. HTTP does not exercise secure HTTPS cookies. The phone's native camera can open an HTTP QR link; this version does not use browser camera APIs.

### Option B: HTTPS tunnel, preferred realistic phone test

1. Build Angular and run Go serving both UI and API at http://localhost:8080.
2. Install cloudflared if absent, using current official instructions.
3. Start `cloudflared tunnel --url http://localhost:8080`.
4. Set PUBLIC_BASE_URL to the generated https://...trycloudflare.com origin and COOKIE_SECURE=true. Restart the app if necessary while keeping the tunnel running.
5. Open the tunnel URL in the PC display browser, log in as admin, change the default password before exposing meaningful data, and activate the display. Use the same tunnel origin on the phone.
6. Create an employee, scan, log in once, and verify subsequent scans complete without login.

The tunnel forwards to the PC; the PC process must stay running. Quick Tunnel URLs are temporary and may change after restart. A changed hostname means different browser cookies and requires logging in and provisioning the display again on that hostname. A named tunnel with a stable hostname can be considered later. Do not add tunnel-level login that would intercept the intended employee flow.

### Vercel deployment in the future project workspace

Target architecture: GitHub repository `qr-attendance` -> Vercel build -> static Angular frontend plus Go Functions -> hosted Turso/libSQL database. Browser requests use the same Vercel origin for pages and REST calls.

Vercel supports Go HTTP handlers, but its function filesystem does not provide durable local SQLite storage. Hosted libSQL preserves SQLite-compatible storage while removing dependence on a particular function instance. Validate this integration with a small Go handler and a database transaction before implementing the complete application. If current tooling or account availability prevents this, report the exact blocker before choosing an alternative.

No purchased domain is required. Vercel assigns a HTTPS `.vercel.app` address; the exact available hostname is determined during project creation. Do not promise that `qr-attendance.vercel.app` is available. A custom domain is optional and can be connected later.

Publication sequence, after the user authorizes it in the new workspace:

1. Confirm authenticated GitHub and Vercel accounts and intended ownership. Prefer a private GitHub repository by default, unless the user requests public visibility. Do not overwrite an existing repository/project with the same name.
2. Prepare a dedicated repository containing application source, lockfiles, migrations, tests, configuration examples, this plan, and setup documentation. Exclude `.env`, database files, local credentials, runtime logs, build caches, and unrelated device SDK material.
3. Create the `qr-attendance` repository, commit reviewed source, and push. Use the repository's existing branch convention; for a new repository, use main as its default branch.
4. Create/import the Vercel project from that repository. Include checked-in Vercel configuration for Angular build/output, Go API entry point, API routing, and SPA deep links. API and asset rules must take precedence over SPA fallback. Verify the deployed route retains the path expected by the Go router.
5. Provision the hosted database through an available supported integration or the provider account, without buying a plan or domain. If billing or a paid resource is required, present the concrete cost and ask first. Choose a function/database region pairing that minimizes latency.
6. Set hosted database secrets, PUBLIC_BASE_URL, COOKIE_SECURE=true, and a strong BOOTSTRAP_ADMIN_PASSWORD as server-only environment variables. The known admin/admin credentials remain for local development; never publish a working public administrator with that password.
7. Run migrations and the one-time administrator bootstrap through an explicit documented release/setup command. Do not run migrations independently on every cold start or on every request. Make setup safe to rerun and never expose a public bootstrap endpoint.
8. Keep preview and production databases/secrets separate. Preview builds and pull requests must not mutate production data. A preview must use a stable browser-reachable origin appropriate to that environment for QR URLs.
9. Verify a preview deployment, then promote to production. Check API routing, persistent writes across separate requests/cold starts, HttpOnly/Secure cookies, CSRF, employee/admin permissions, QR interval updates, and mobile deep links. For phone testing, the scan and login routes must be accessible without an intervening Vercel team-login screen; configure deployment protection appropriately for the chosen test deployment.
10. Configure the production canonical URL, create a test employee, activate the monitor display on that same origin, and test first-login and remembered-session scans on a real phone. Provide the verified repository and deployment links and state any checks that could not be performed.

Serverless runtime requirements: no background rotation loop, in-memory-only sessions, local-file rate limiting, or persistent goroutines required for correctness. Derive QR intervals from server time and persist shared state. Use database-backed rate limits or a suitable shared service. Do bounded opportunistic cleanup or a separately configured scheduled cleanup task; do not assume a Go process remains alive between requests. Document a backup/export and restore procedure for the hosted database.

Vercel function cold starts and database round trips may affect scan speed. Measure real scan-to-success time in the deployed environment; optimize unnecessary requests without weakening QR validation, browser binding, or authorization.

## 12. Implementation sequence

1. In the new dedicated `qr-attendance` workspace, inspect instructions and installed Go/Node/npm/SQLite tools. Resolve required dependencies; document versions and installation needs. Validate the Go-on-Vercel and remote libSQL integration before full implementation. Scaffold backend and Angular without overwriting unrelated files.
2. Implement migrations, bootstrap admin, user model, password hashing, sessions, CSRF, permissions, and user management.
3. Implement login, account settings, and admin user screens; verify employee/admin separation.
4. Implement settings, restricted display provisioning, server-controlled QR rotation, and full-screen display UI.
5. Implement browser-bound scan attempts, login continuation, automatic completion, receipts, and raw event storage.
6. Implement employee and admin history screens with filtering, timezone-aware display, and pagination.
7. Package Angular behind Go for local testing; add development proxy and repeatable Windows-friendly build/run commands. Add a stateless Go function entry point and Vercel routing/build configuration for hosted mode.
8. Run meaningful backend/integration/frontend checks, then test the actual phone workflow over LAN or HTTPS tunnel when available. Report clearly if physical-device testing was not possible.
9. Deliver README, API documentation, configuration examples, dependency guidance, and known limitations. Do not claim successful runtime testing based only on source inspection.
10. Only when authorized in that workspace, publish to GitHub and deploy to Vercel using the publication sequence above. The current session creates only this plan.

## 13. Acceptance criteria and verification

- Fresh database seeds admin/admin exactly once; changing the password survives restart.
- Admin can create an employee, edit/deactivate them, reset their password, and change QR interval. Non-admin direct API calls are rejected.
- Deactivation/password reset invalidates relevant existing sessions. Last-admin protection works.
- Unprovisioned browsers cannot fetch the live challenge endpoint. Display credentials cannot call admin APIs.
- QR rotates at the configured interval without reload; multiple polls reuse the interval's token; settings changes propagate promptly.
- An employee's first valid scan survives login for up to two minutes and automatically produces one event using the initial server receipt time.
- Later scans in the same browser need no login while its session remains valid. No confirmation tap is added by the application.
- Invalid/expired challenges and expired pending attempts create no event. Ordinary login creates no event.
- Retrying or concurrently completing one attempt returns one event. Another browser cannot complete a stolen attempt ID without its flow binding.
- Several employees can use the same displayed challenge. Separate intentional scans remain raw independent events.
- Employees cannot view others' attendance or choose a different employee/timestamp in submission payloads. Admin can filter and view all events.
- QR GET requests alone create no event. CSRF protection covers automatic submission and admin mutations.
- History and users persist after restart; temporary-data cleanup preserves historical events.
- UTC storage and Asia/Tehran date filters handle local-day boundaries correctly.
- A production Angular build loads /scan and other deep links through Go. API 404s remain JSON API errors.
- QR URLs use the configured phone-reachable origin; no frontend API request sends the phone to localhost.
- Test the expiry boundary, failed login then retry, session expiry, missing cookies, changed browser, server errors, and reloading the receipt.
- Hosted mode uses durable external storage for all shared state. Local mode still runs with an embedded SQLite file. Integration tests exercise both modes' transactions and constraints.
- Vercel production URL loads Angular routes and API endpoints correctly, uses secure cookies, and persists events independently of function-instance lifetime. No database credentials appear in frontend artifacts or repository history.
- Preview deployments cannot write production attendance. Public deployment has no active admin/admin default password. No domain purchase is required.
- Run go test ./..., relevant frontend tests, and production builds. Include a small end-to-end suite for login-to-attendance and role isolation; do not rely only on mocked UI tests.

## 14. Documentation sources

Consult current official documentation during implementation; these explain the hosting and testing choices:

- [Angular development server](https://angular.dev/cli/serve)
- [Angular proxying and development serving](https://angular.dev/tools/cli/serve)
- [Angular deployment and deep-link fallback](https://angular.dev/tools/cli/deployment)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- [Vercel Go runtime](https://vercel.com/docs/functions/runtimes/go)
- [Vercel function runtimes and filesystem constraints](https://vercel.com/docs/functions/runtimes)
- [SQLite documentation](https://sqlite.org/docs.html)
- [Vercel generated domains](https://vercel.com/docs/domains/working-with-domains)
- [Vercel storage integrations](https://vercel.com/docs/marketplace-storage)
- [Vercel guidance on local SQLite](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel)
- [Turso Go integration](https://turso.tech/go)
- [libSQL Go client](https://github.com/tursodatabase/libsql-client-go)
