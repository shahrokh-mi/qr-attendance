# Deployment options: one service, several hosts

Status: analysis only. No code has been changed for hosting. Facts below were checked against the
code in this repository and Vercel's Go runtime documentation (page last updated 2026-08-11).

## 1. The app is already one service

`cmd/server/main.go` is a single `net/http` server on a single port:

- `app.routes(mux)` registers every API route under `/api/v1`.
- `withFrontend()` serves the built Angular bundle from `WEB_DIST`
  (default `./web/dist/qr-attendance-web/browser`), with an SPA fallback to `index.html`
  and 404 for unknown paths that carry a file extension.
- `//go:embed migrations/001_init.sql` embeds only the schema.
- The Angular client calls `fetch('/api/v1' + path)` with `credentials: 'same-origin'` and an
  `X-CSRF-Token` header, and `index.html` uses `<base href="/">`. The frontend already assumes
  it is served from the same origin as the API.

So "two services" is a build-time and dev-time artifact, not a runtime topology:

- `scripts/run-local.sh` runs `npm --prefix web ci`, `npm run build`, then `go run ./cmd/server`.
- `web/proxy.conf.json` exists only so `ng serve` on :4200 can forward `/api` to :8080.

Producing one deployable unit means shipping the built bundle with the Go binary, nothing more.

## 2. What Vercel supports for Go today

From Vercel's "Using the Go Runtime with Vercel Functions" (Beta, all plans):

| Property | What the docs say | This repo |
| --- | --- | --- |
| Detect entrypoint | root `go.mod` plus `main.go`, `cmd/api/main.go`, or `cmd/server/main.go` | matches `cmd/server/main.go` |
| Framework preset | must be `go` | needs `vercel.json` |
| Port | server must listen on `$PORT` | currently `LISTEN_ADDR`, default `127.0.0.1:8080` |
| Go version | read from the `go` directive in `go.mod` | `go 1.26.0` — support must be confirmed |
| Dependencies | `go.mod`/`go.sum`, `-mod=vendor` if vendored | fine |
| Build | default `go build`, overridable with `buildCommand` | needs a build step that also builds Angular |
| Static assets | not served automatically; the function must serve them | code reads `./web/dist` from disk |
| Two runtimes in one project | possible via "Services" | not required |

Two consequences:

1. The Angular bundle must be embedded into the binary (`go:embed` of the built `dist`) or shipped
   via function `includeFiles`; a runtime `os.Stat` against `web/dist` will not find anything.
2. The server must bind `$PORT` and be reachable from the platform, i.e. `0.0.0.0`.

## 3. The real constraint is storage, not the number of services

Serverless functions get an ephemeral filesystem and scale horizontally, so a SQLite file plus its
WAL on local disk cannot be the system of record. This is independent of the frontend/backend split.

Already serverless-safe in this codebase:

- sessions, CSRF tokens, rate-limit windows and QR challenges are all rows in the database;
- `cleanup()` is called at startup and again inside the scan exchange, and only deletes expired rows,
  so it is idempotent and needs no timer;
- no in-process cache holds state across requests (the `map[string]...` values are response payloads).

Not yet safe behind a proxy or across instances:

- rate-limit buckets are keyed by `remoteIP(r.RemoteAddr)` (login 20/min, display provisioning 5/h,
  scan exchange 60/min); behind Vercel or any load balancer `RemoteAddr` is the platform address, so
  every client collapses into one bucket — needs a trusted `X-Forwarded-For` read;
- `db.SetMaxOpenConns(1)` is per process; with many instances each opens its own connection, so a
  serverless Postgres needs a pooler (Neon pooled endpoint, pgbouncer, or `pgxpool` with a small max);
- cleanup will not run during idle periods; either accept that (traffic triggers it) or add a Vercel
  Cron hitting a protected endpoint.

## 4. Options

| # | Shape | Runtime units | Storage | Code work | Main risks |
| --- | --- | --- | --- | --- | --- |
| A | Go function on Vercel serving API + SPA | 1 | Postgres (pgx) | embed dist, `$PORT`, port schema + 35 queries, proxy-IP trust | Go runtime Beta, cold starts, pooled connections required |
| B | Go function on Vercel serving API + SPA | 1 | Turso / libSQL | embed dist, `$PORT`, ~4 statements | Go driver has no tagged release (`v0.0.0-20260528…`) and transaction semantics are unverified — the attendance commit path uses `tx` |
| C | Static SPA on Vercel + Go API as a second Vercel service | 2 | any | API base URL in the client, cross-origin cookie + CSRF origin rules | loses the same-origin model the client is written against; two runtimes to operate |
| D | One container on Fly.io / Railway / Render / VPS with a volume | 1 | SQLite (unchanged) | Dockerfile, `$PORT`, embed dist or a mounted volume | not Vercel; ~$5/mo host; still one service |

Option C is the shape that usually gets called "two services". A, B and D all keep one process
serving both the API and the UI, which is what the code already does.

## 5. Cost of porting storage

Postgres (pgx v5.11.0, tagged and mature):

- 35 query call sites in `cmd/server/main.go`;
- SQLite-isms to rewrite: `INSERT OR IGNORE` ×3, `INSERT OR REPLACE` ×1, `PRAGMA foreign_keys=ON` ×1,
  and `?` placeholders become `$1..$n`;
- the schema in `migrations/001_init.sql` is portable: TEXT primary keys, no `AUTOINCREMENT`, booleans
  stored as `INTEGER` and scanned into `int`, timestamps stored as RFC3339 `TEXT`, `CURRENT_TIMESTAMP`
  is valid Postgres. Converting timestamps to `TIMESTAMPTZ` is optional cleanup, not a blocker;
- `migrations/001_init.sql` and `cmd/server/migrations/001_init.sql` are byte-identical duplicates —
  port both, or collapse to one embedded copy.

Turso / libSQL: keeps the dialect, so the SQL rewrite is small; the risk is the Go driver release
status and whether the write-conflict path behaves like SQLite's `Begin()` inside a function.

Recommended seam: open the driver from a `DB_DSN`-style variable (`postgres://…` vs `file:…`) behind
one small `Store` layer, so developers keep SQLite locally and production runs Postgres without two
code paths.

## 6. Non-negotiables for any hosted deploy

- `PUBLIC_BASE_URL` set to the deployed HTTPS origin (used for CSRF origin checks and QR URLs).
- `COOKIE_SECURE=true`; the session cookie is HttpOnly + SameSite=Lax.
- `QR_CHALLENGE_SECRET` stable, ≥ 32 random bytes, unique per environment; rotating it invalidates
  live QR challenges.
- `BOOTSTRAP_ADMIN_PASSWORD` strong before first initialisation; the default `admin/admin` is local-only.
- Separate database and secrets for preview and production.

## 7. Recommendation

A is the closest fit for "one service on Vercel" and the code is already serverless-friendly in the
places that usually hurt (state lives in the database). It costs a Postgres port plus the embed,
`$PORT` and proxy-IP fixes. B is less SQL work but adds driver risk on the write path. D keeps the
current storage untouched and can reuse the same embed/`$PORT` work if the storage seam is in place.

Decision needed before implementation:

1. Postgres provider and region (Neon, Prisma Postgres, Supabase via the Vercel Marketplace).
2. Confirm Vercel supports the `go 1.26.0` directive, or pin the toolchain.
3. Cleanup strategy: request-triggered only, or a Cron endpoint.
4. Whether `X-Forwarded-For` is trusted from the platform and how far to harden `remoteIP`.
5. Dual-driver (SQLite locally / Postgres in production) or Postgres-only.
