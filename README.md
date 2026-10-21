# qr-attendance

A single-company attendance collection prototype. Employees scan the entrance QR with a phone camera; the server creates a raw event with a server-side timestamp. The application does not infer entry/exit, hours, lateness, or payroll outcomes.

## Current state

The local application contains a Go REST API, Angular portal, SQLite migration, admin user management, persistent sessions, CSRF checks, display enrollment, rotating QR challenges, browser-bound attendance attempts, and employee/admin event lists.

**Hosted mode is not configured or deployable yet.** The Go module named in the original plan (libsql-client-go) is deprecated. The newer Turso Go driver is currently documented as beta, and the official materials reviewed for this implementation did not establish the remote hosted database transaction support this application needs. This project deliberately uses durable local SQLite only until that remote adapter is validated. No Vercel configuration, hosted secrets, or cloud database has been created. The source is published at https://github.com/shahrokh-mi/qr-attendance.

## Requirements

- Go 1.26 or newer
- Node.js 22.22+ or 24.15+ (Angular 22 supports both; this workspace was built with Node 26.5)
- npm 11+
- Git
- No SQLite server or standalone sqlite3 CLI is needed; the Go driver includes the SQLite engine.

## Run locally

On Linux/macOS:

    cp .env.example .env
    export LISTEN_ADDR=127.0.0.1:8080
    export PUBLIC_BASE_URL=http://localhost:8080
    export DATABASE_PATH=./data/attendance.db
    export COOKIE_SECURE=false
    export BOOTSTRAP_ADMIN_PASSWORD=admin
    export QR_CHALLENGE_SECRET="$(openssl rand -hex 32)"
    ./scripts/run-local.sh

On Windows PowerShell:

    Copy-Item .env.example .env
    $env:LISTEN_ADDR = '127.0.0.1:8080'
    $env:PUBLIC_BASE_URL = 'http://localhost:8080'
    $env:DATABASE_PATH = './data/attendance.db'
    $env:COOKIE_SECURE = 'false'
    $env:BOOTSTRAP_ADMIN_PASSWORD = 'admin'
    $env:QR_CHALLENGE_SECRET = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    ./scripts/run-local.ps1

The server does not read .env automatically. The checked-in scripts install frontend dependencies, build Angular, then start Go. Open http://localhost:8080.

The first database initialization creates admin / admin only when there is no active admin. Change the password in Account before putting real employee data in the app. Set a strong BOOTSTRAP_ADMIN_PASSWORD before initializing a fresh database if you don't want the local default.

Open Settings, activate the browser as the entrance display, then sign out of the admin account on that monitor. The display has a separate, restricted HttpOnly credential. Use Revoke active display credentials to revoke it.

## Test on a phone

A phone's localhost is the phone, not the computer. For an HTTPS tunnel or LAN test, set PUBLIC_BASE_URL to the exact reachable origin used by both the display and phone, set COOKIE_SECURE=true for HTTPS, and restart the server. HTTP on a trusted private LAN requires COOKIE_SECURE=false; it does not exercise HTTPS cookie protections. Keep local development credentials and data disposable when using plain HTTP.

For Angular development with the proxy, run Go on port 8080 and use npm --prefix web start. The browser origin is port 4200, so set PUBLIC_BASE_URL=http://localhost:4200 for CSRF origin validation during that local-only workflow. The Angular proxy is defined in web/proxy.conf.json.

## API and database

The REST routes are under /api/v1; the checked-in contract is docs/openapi.yaml. The SQL schema is migrations/001_init.sql. Local database files live under data/ and are excluded from Git.

The session cookie is HttpOnly, SameSite=Lax, and Secure by default. Set COOKIE_SECURE=false only for local HTTP. QR challenge tokens are derived from QR_CHALLENGE_SECRET; keep the secret stable across restarts, and use different random secrets for separate environments. Do not expose it to Angular or commit it.

## Vercel and hosted database

Do not deploy this build yet. A Vercel Function filesystem is not durable database storage. Before Vercel deployment, the hosted Turso/libSQL driver must be selected and validated for Go runtime compatibility, write transactions, concurrency, and schema migrations. That work requires a working Turso account/database and credentials. Production and preview need separate databases and secrets. After the remote adapter is validated, deployment also needs connected GitHub and Vercel accounts so the repository can be published and imported.

The GitHub and Vercel integrations were surfaced for connection in Codex, but this session cannot complete the account connection step itself. The repository is now published; the remaining user action is to connect a Vercel account so the repository can be imported. No provider credentials have been requested or stored here.

## Known limitations

This is an initial implementation, not a public-production release. The local build includes basic database-backed throttling, temporary-record cleanup, and paginated date/employee filters. A deeper security review, password-reset audit, backup/restore automation, hosted storage adapter, and deploy validation still need work. The basic integration tests cover role isolation, display provisioning, browser binding, and idempotent attendance completion. No physical phone test or cloud deployment has been performed.
