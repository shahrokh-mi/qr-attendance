package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

type App struct {
	db     *sql.DB
	secure bool
}
type User struct {
	ID                     string `json:"id"`
	EmployeeCode           string `json:"employee_code"`
	Username               string `json:"username"`
	DisplayName            string `json:"display_name"`
	Role                   string `json:"role"`
	Active                 bool   `json:"active"`
	DefaultPasswordPending bool   `json:"default_password_pending"`
}
type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func main() {
	path := env("DATABASE_PATH", "./data/attendance.db")
	_ = os.MkdirAll(filepath.Dir(path), 0700)
	db, err := sql.Open("sqlite", path+"?_foreign_keys=on&_busy_timeout=5000&_journal_mode=WAL")
	if err != nil {
		log.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if len(os.Getenv("QR_CHALLENGE_SECRET")) < 32 {
		log.Fatal("QR_CHALLENGE_SECRET must contain at least 32 random bytes")
	}
	base, parseErr := url.Parse(env("PUBLIC_BASE_URL", "http://localhost:8080"))
	if parseErr != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" || base.User != nil || (base.Path != "" && base.Path != "/") || base.RawQuery != "" || base.Fragment != "" {
		log.Fatal("PUBLIC_BASE_URL must be an origin such as https://attendance.example.com")
	}
	if err = initDB(context.Background(), db); err != nil {
		log.Fatal(err)
	}
	app := &App{db: db, secure: env("COOKIE_SECURE", "true") == "true"}
	if err = app.seedAdmin(); err != nil {
		log.Fatal(err)
	}
	app.cleanup()
	mux := http.NewServeMux()
	app.routes(mux)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "not_found", "API route was not found.") })
	addr := env("LISTEN_ADDR", "127.0.0.1:8080")
	log.Printf("qr-attendance listening at %s", addr)
	log.Fatal(http.ListenAndServe(addr, securityHeaders(withFrontend(mux))))
}

func withFrontend(api http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			api.ServeHTTP(w, r)
			return
		}
		root := env("WEB_DIST", "./web/dist/qr-attendance-web/browser")
		clean := filepath.Clean("/" + r.URL.Path)
		candidate := filepath.Join(root, clean)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			http.ServeFile(w, r, candidate)
			return
		}
		if filepath.Ext(r.URL.Path) != "" {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(root, "index.html"))
	})
}

func durationEnv(k string, fallback time.Duration) time.Duration {
	value := env(k, "")
	if value == "" {
		return fallback
	}
	d, err := time.ParseDuration(value)
	if err != nil || d <= 0 {
		log.Printf("invalid %s; using default", k)
		return fallback
	}
	return d
}
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

//go:embed migrations/001_init.sql
var initialSchema string

func initDB(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, initialSchema)
	return err
}
func remoteIP(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err == nil {
		return host
	}
	return addr
}
func (a *App) cleanup() {
	retain := time.Now().UTC().Add(-30 * 24 * time.Hour).Format(time.RFC3339Nano)
	old := time.Now().UTC().Add(-48 * time.Hour).Format(time.RFC3339Nano)
	_, _ = a.db.Exec("DELETE FROM attendance_attempts WHERE expires_at<?", retain)
	_, _ = a.db.Exec("DELETE FROM qr_challenges WHERE expires_at<?", retain)
	_, _ = a.db.Exec("DELETE FROM browser_flows WHERE expires_at<?", old)
	_, _ = a.db.Exec("DELETE FROM sessions WHERE expires_at<? OR revoked_at<?", retain, retain)
	_, _ = a.db.Exec("DELETE FROM rate_limits WHERE window_started_at<?", old)
}
func (a *App) allow(bucket string, limit int, span time.Duration) bool {
	tx, err := a.db.Begin()
	if err != nil {
		return false
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	key := hash(bucket)
	_, err = tx.Exec("INSERT OR IGNORE INTO rate_limits(bucket,window_started_at,request_count) VALUES(?,?,0)", key, stamp)
	if err != nil {
		return false
	}
	var started string
	var count int
	if err = tx.QueryRow("SELECT window_started_at,request_count FROM rate_limits WHERE bucket=?", key).Scan(&started, &count); err != nil {
		return false
	}
	at, e := time.Parse(time.RFC3339Nano, started)
	if e != nil {
		return false
	}
	if now.Sub(at) >= span {
		count = 0
		started = stamp
	}
	count++
	_, err = tx.Exec("UPDATE rate_limits SET window_started_at=?,request_count=? WHERE bucket=?", started, count, key)
	if err != nil {
		return false
	}
	if err = tx.Commit(); err != nil {
		return false
	}
	return count <= limit
}
func randomID() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func token() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func hash(v string) string { s := sha256.Sum256([]byte(v)); return hex.EncodeToString(s[:]) }
func (a *App) seedAdmin() error {
	var n int
	if e := a.db.QueryRow(`SELECT count(*) FROM users WHERE role='admin' AND active=1`).Scan(&n); e != nil {
		return e
	}
	if n > 0 {
		return nil
	}
	pass := env("BOOTSTRAP_ADMIN_PASSWORD", "admin")
	p, e := bcrypt.GenerateFromPassword([]byte(pass), bcrypt.DefaultCost)
	if e != nil {
		return e
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, e = a.db.Exec(`INSERT OR IGNORE INTO users(id,employee_code,username_normalized,username,display_name,password_hash,role,active,default_password_pending,created_at,updated_at) VALUES(?,?,?,?,?,?, 'admin',1,?,?,?)`, randomID(), "ADMIN-001", "admin", "admin", "Administrator", string(p), boolInt(pass == "admin"), now, now)
	return e
}
func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'")
		next.ServeHTTP(w, r)
	})
}
func (a *App) routes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, r *http.Request) { write(w, 200, map[string]any{"status": "ok"}) })
	m.HandleFunc("GET /api/v1/auth/csrf", a.csrf)
	m.HandleFunc("POST /api/v1/auth/login", a.login)
	m.HandleFunc("POST /api/v1/auth/logout", a.logout)
	m.HandleFunc("GET /api/v1/auth/me", a.me)
	m.HandleFunc("POST /api/v1/auth/change-password", a.changePassword)
	m.HandleFunc("GET /api/v1/attendance/me", a.myEvents)
	m.HandleFunc("GET /api/v1/admin/users", a.adminUsers)
	m.HandleFunc("POST /api/v1/admin/users", a.createUser)
	m.HandleFunc("PATCH /api/v1/admin/users/{id}", a.updateUser)
	m.HandleFunc("POST /api/v1/admin/users/{id}/reset-password", a.resetPassword)
	m.HandleFunc("GET /api/v1/admin/attendance", a.allEvents)
	m.HandleFunc("GET /api/v1/admin/settings", a.settings)
	m.HandleFunc("PATCH /api/v1/admin/settings", a.updateSettings)
	m.HandleFunc("POST /api/v1/admin/display/activate", a.activateDisplay)
	m.HandleFunc("POST /api/v1/admin/display/revoke", a.revokeDisplay)
	m.HandleFunc("GET /api/v1/display/challenge", a.displayChallenge)
	m.HandleFunc("POST /api/v1/attendance/attempts", a.createAttempt)
	m.HandleFunc("POST /api/v1/attendance/attempts/{id}/complete", a.completeAttempt)
}
func write(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, code, msg string) {
	write(w, status, map[string]any{"error": apiError{code, msg}})
}
func decode(r *http.Request, v any) error {
	d := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	d.DisallowUnknownFields()
	return d.Decode(v)
}
func (a *App) csrf(w http.ResponseWriter, r *http.Request) {
	c, e := r.Cookie("csrf")
	if e != nil || len(c.Value) < 32 {
		cval := token()
		http.SetCookie(w, &http.Cookie{Name: "csrf", Value: cval, Path: "/", HttpOnly: false, Secure: a.secure, SameSite: http.SameSiteLaxMode, MaxAge: 86400})
		c = &http.Cookie{Value: cval}
	}
	write(w, 200, map[string]string{"csrf_token": c.Value})
}
func (a *App) checkCSRF(w http.ResponseWriter, r *http.Request) bool {
	c, e := r.Cookie("csrf")
	if e != nil || c.Value == "" || r.Header.Get("X-CSRF-Token") != c.Value {
		fail(w, 403, "csrf_failed", "Refresh the page and try again.")
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != strings.TrimRight(env("PUBLIC_BASE_URL", schemeHost(r)), "/") {
		fail(w, 403, "origin_invalid", "Request origin is not allowed.")
		return false
	}
	return true
}
func schemeHost(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}
func (a *App) login(w http.ResponseWriter, r *http.Request) {
	if !a.allow("login:"+remoteIP(r.RemoteAddr), 20, time.Minute) {
		fail(w, 429, "rate_limited", "Too many login attempts. Wait one minute and try again.")
		return
	}
	if !a.checkCSRF(w, r) {
		return
	}
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if decode(r, &in) != nil {
		fail(w, 400, "invalid_input", "Enter a username and password.")
		return
	}
	var id, ph string
	var active bool
	e := a.db.QueryRow(`SELECT id,password_hash,active FROM users WHERE username_normalized=?`, strings.ToLower(strings.TrimSpace(in.Username))).Scan(&id, &ph, &active)
	if e != nil || !active || bcrypt.CompareHashAndPassword([]byte(ph), []byte(in.Password)) != nil {
		time.Sleep(300 * time.Millisecond)
		fail(w, 401, "invalid_credentials", "Username or password is incorrect.")
		return
	}
	raw := token()
	now := time.Now().UTC()
	ttl := durationEnv("SESSION_TTL", 30*24*time.Hour)
	_, e = a.db.Exec(`INSERT INTO sessions(token_hash,user_id,authenticated_at,created_at,expires_at) VALUES(?,?,?,?,?)`, hash(raw), id, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Add(ttl).Format(time.RFC3339Nano))
	if e != nil {
		fail(w, 500, "server_error", "Could not start session.")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "session", Value: raw, Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode, Expires: now.Add(ttl), MaxAge: int(ttl.Seconds())})
	write(w, 200, map[string]any{"user": mustUser(a.db, id)})
}
func (a *App) current(w http.ResponseWriter, r *http.Request) (User, bool) {
	c, e := r.Cookie("session")
	if e != nil {
		fail(w, 401, "unauthenticated", "Please log in.")
		return User{}, false
	}
	var u User
	var active int
	e = a.db.QueryRow(`SELECT u.id,u.employee_code,u.username,u.display_name,u.role,u.active,u.default_password_pending FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?`, hash(c.Value), time.Now().UTC().Format(time.RFC3339Nano)).Scan(&u.ID, &u.EmployeeCode, &u.Username, &u.DisplayName, &u.Role, &active, &u.DefaultPasswordPending)
	u.Active = active == 1
	if e != nil || !u.Active {
		fail(w, 401, "unauthenticated", "Please log in.")
		return User{}, false
	}
	return u, true
}
func mustUser(db *sql.DB, id string) User {
	var u User
	var active int
	_ = db.QueryRow(`SELECT id,employee_code,username,display_name,role,active,default_password_pending FROM users WHERE id=?`, id).Scan(&u.ID, &u.EmployeeCode, &u.Username, &u.DisplayName, &u.Role, &active, &u.DefaultPasswordPending)
	u.Active = active == 1
	return u
}
func (a *App) me(w http.ResponseWriter, r *http.Request) {
	u, ok := a.current(w, r)
	if ok {
		write(w, 200, map[string]any{"user": u})
	}
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	if !a.checkCSRF(w, r) {
		return
	}
	if c, e := r.Cookie("session"); e == nil {
		_, _ = a.db.Exec(`UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL`, time.Now().UTC().Format(time.RFC3339Nano), hash(c.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: "session", Value: "", Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	write(w, 200, map[string]string{"status": "ok"})
}
func (a *App) requireAdmin(w http.ResponseWriter, r *http.Request) (User, bool) {
	u, ok := a.current(w, r)
	if !ok {
		return User{}, false
	}
	if u.Role != "admin" {
		fail(w, 403, "forbidden", "Administrator access is required.")
		return User{}, false
	}
	return u, true
}
func (a *App) changePassword(w http.ResponseWriter, r *http.Request) {
	if !a.checkCSRF(w, r) {
		return
	}
	u, ok := a.current(w, r)
	if !ok {
		return
	}
	var in struct {
		Current string `json:"current_password"`
		New     string `json:"new_password"`
	}
	if decode(r, &in) != nil || len(in.New) < 10 {
		fail(w, 400, "invalid_input", "New password must contain at least 10 characters.")
		return
	}
	var ph string
	_ = a.db.QueryRow(`SELECT password_hash FROM users WHERE id=?`, u.ID).Scan(&ph)
	if bcrypt.CompareHashAndPassword([]byte(ph), []byte(in.Current)) != nil {
		fail(w, 400, "current_password_invalid", "Current password is incorrect.")
		return
	}
	p, _ := bcrypt.GenerateFromPassword([]byte(in.New), bcrypt.DefaultCost)
	_, e := a.db.Exec(`UPDATE users SET password_hash=?,default_password_pending=0,updated_at=? WHERE id=?`, string(p), time.Now().UTC().Format(time.RFC3339Nano), u.ID)
	if e != nil {
		fail(w, 500, "server_error", "Could not update password.")
		return
	}
	if c, e := r.Cookie("session"); e == nil {
		_, _ = a.db.Exec(`UPDATE sessions SET revoked_at=? WHERE user_id=? AND token_hash<>?`, time.Now().UTC().Format(time.RFC3339Nano), u.ID, hash(c.Value))
	}
	write(w, 200, map[string]string{"status": "ok"})
}
func (a *App) createUser(w http.ResponseWriter, r *http.Request) {
	if !a.checkCSRF(w, r) {
		return
	}
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	var in struct {
		EmployeeCode string `json:"employee_code"`
		Username     string `json:"username"`
		DisplayName  string `json:"display_name"`
		Password     string `json:"password"`
		Role         string `json:"role"`
		Active       bool   `json:"active"`
	}
	if decode(r, &in) != nil || len(in.Username) < 3 || len(in.DisplayName) < 1 || len(in.Password) < 10 || (in.Role != "admin" && in.Role != "employee") {
		fail(w, 400, "invalid_input", "Provide a username, display name, 10-character password, and valid role.")
		return
	}
	if in.EmployeeCode == "" {
		in.EmployeeCode = "EMP-" + strings.ToUpper(randomID()[:8])
	}
	p, _ := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	id := randomID()
	_, e := a.db.Exec(`INSERT INTO users(id,employee_code,username_normalized,username,display_name,password_hash,role,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, in.EmployeeCode, strings.ToLower(strings.TrimSpace(in.Username)), strings.TrimSpace(in.Username), strings.TrimSpace(in.DisplayName), string(p), in.Role, boolInt(in.Active), now, now)
	if e != nil {
		fail(w, 409, "conflict", "Username or employee code is already in use.")
		return
	}
	write(w, 201, map[string]any{"user": mustUser(a.db, id)})
}
func (a *App) adminUsers(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	rows, e := a.db.Query(`SELECT id,employee_code,username,display_name,role,active,default_password_pending FROM users ORDER BY display_name,id`)
	if e != nil {
		fail(w, 500, "server_error", "Could not load users.")
		return
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		var u User
		var active int
		if rows.Scan(&u.ID, &u.EmployeeCode, &u.Username, &u.DisplayName, &u.Role, &active, &u.DefaultPasswordPending) == nil {
			u.Active = active == 1
			out = append(out, u)
		}
	}
	write(w, 200, map[string]any{"items": out, "total": len(out)})
}
func (a *App) updateUser(w http.ResponseWriter, r *http.Request) {
	if !a.checkCSRF(w, r) {
		return
	}
	admin, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	var old User
	var active int
	e := a.db.QueryRow(`SELECT id,employee_code,username,display_name,role,active,default_password_pending FROM users WHERE id=?`, id).Scan(&old.ID, &old.EmployeeCode, &old.Username, &old.DisplayName, &old.Role, &active, &old.DefaultPasswordPending)
	if e != nil {
		fail(w, 404, "not_found", "User was not found.")
		return
	}
	old.Active = active == 1
	var in struct {
		EmployeeCode string `json:"employee_code"`
		Username     string `json:"username"`
		DisplayName  string `json:"display_name"`
		Role         string `json:"role"`
		Active       bool   `json:"active"`
	}
	if decode(r, &in) != nil || in.Username == "" || in.DisplayName == "" || (in.Role != "admin" && in.Role != "employee") {
		fail(w, 400, "invalid_input", "Check the user fields.")
		return
	}
	if old.Role == "admin" && old.Active && (in.Role != "admin" || !in.Active) {
		var n int
		_ = a.db.QueryRow(`SELECT count(*) FROM users WHERE role='admin' AND active=1`).Scan(&n)
		if n <= 1 {
			fail(w, 409, "last_admin", "At least one active administrator is required.")
			return
		}
	}
	_, e = a.db.Exec(`UPDATE users SET employee_code=?,username_normalized=?,username=?,display_name=?,role=?,active=?,updated_at=? WHERE id=?`, in.EmployeeCode, strings.ToLower(strings.TrimSpace(in.Username)), strings.TrimSpace(in.Username), strings.TrimSpace(in.DisplayName), in.Role, boolInt(in.Active), time.Now().UTC().Format(time.RFC3339Nano), id)
	if e != nil {
		fail(w, 409, "conflict", "Username or employee code is already in use.")
		return
	}
	if !in.Active || in.Role != "admin" && old.Role == "admin" {
		_, _ = a.db.Exec(`UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`, time.Now().UTC().Format(time.RFC3339Nano), id)
	}
	if id == admin.ID {
		write(w, 200, map[string]any{"user": mustUser(a.db, id)})
		return
	}
	write(w, 200, map[string]any{"user": mustUser(a.db, id)})
}
func (a *App) resetPassword(w http.ResponseWriter, r *http.Request) {
	if !a.checkCSRF(w, r) {
		return
	}
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	var in struct {
		Password string `json:"password"`
	}
	if decode(r, &in) != nil || len(in.Password) < 10 {
		fail(w, 400, "invalid_input", "Password must contain at least 10 characters.")
		return
	}
	p, _ := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	id := r.PathValue("id")
	res, e := a.db.Exec(`UPDATE users SET password_hash=?,default_password_pending=0,updated_at=? WHERE id=?`, string(p), time.Now().UTC().Format(time.RFC3339Nano), id)
	n, _ := res.RowsAffected()
	if e != nil || n == 0 {
		fail(w, 404, "not_found", "User was not found.")
		return
	}
	_, _ = a.db.Exec(`UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`, time.Now().UTC().Format(time.RFC3339Nano), id)
	write(w, 200, map[string]string{"status": "ok"})
}
func (a *App) myEvents(w http.ResponseWriter, r *http.Request) {
	u, ok := a.current(w, r)
	if !ok {
		return
	}
	a.listEvents(w, r, false, u.ID)
}
func (a *App) allEvents(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	a.listEvents(w, r, true, "")
}
func (a *App) listEvents(w http.ResponseWriter, r *http.Request, admin bool, userID string) {
	page := 1
	pageSize := 25
	if v := r.URL.Query().Get("page"); v != "" {
		if n, e := strconv.Atoi(v); e != nil || n < 1 {
			fail(w, 400, "invalid_input", "Page must be a positive integer.")
			return
		} else {
			page = n
		}
	}
	if v := r.URL.Query().Get("page_size"); v != "" {
		if n, e := strconv.Atoi(v); e != nil || n < 1 || n > 100 {
			fail(w, 400, "invalid_input", "Page size must be between 1 and 100.")
			return
		} else {
			pageSize = n
		}
	}
	where := []string{"1=1"}
	args := []any{}
	if !admin {
		where = append(where, "user_id=?")
		args = append(args, userID)
	}
	for _, field := range []string{"from", "to"} {
		if raw := r.URL.Query().Get(field); raw != "" {
			instant, e := time.Parse(time.RFC3339, raw)
			if e != nil {
				fail(w, 400, "invalid_input", "Date filters must be RFC 3339 timestamps.")
				return
			}
			op := ">="
			if field == "to" {
				op = "<"
			}
			where = append(where, "recorded_at"+op+"?")
			args = append(args, instant.UTC().Format(time.RFC3339Nano))
		}
	}
	if admin {
		if code := strings.TrimSpace(r.URL.Query().Get("employee_code")); code != "" {
			where = append(where, "employee_code_snapshot=?")
			args = append(args, code)
		}
	}
	clause := strings.Join(where, " AND ")
	var total int
	if e := a.db.QueryRow("SELECT count(*) FROM attendance_events WHERE "+clause, args...).Scan(&total); e != nil {
		fail(w, 500, "server_error", "Could not count attendance events.")
		return
	}
	listArgs := append(append([]any{}, args...), pageSize, (page-1)*pageSize)
	rows, e := a.db.Query("SELECT id,user_id,employee_code_snapshot,recorded_at,committed_at FROM attendance_events WHERE "+clause+" ORDER BY recorded_at DESC,id DESC LIMIT ? OFFSET ?", listArgs...)
	if e != nil {
		fail(w, 500, "server_error", "Could not load attendance.")
		return
	}
	defer rows.Close()
	items := []map[string]string{}
	for rows.Next() {
		var id, uid, code, recorded, committed string
		if rows.Scan(&id, &uid, &code, &recorded, &committed) == nil {
			items = append(items, map[string]string{"id": id, "user_id": uid, "employee_code": code, "recorded_at": recorded, "committed_at": committed})
		}
	}
	write(w, 200, map[string]any{"items": items, "total": total, "page": page, "page_size": pageSize})
}
func (a *App) settings(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	var interval, version int
	var updated string
	_ = a.db.QueryRow(`SELECT qr_interval,schedule_version,updated_at FROM settings WHERE id=1`).Scan(&interval, &version, &updated)
	write(w, 200, map[string]any{"qr_interval": interval, "schedule_version": version, "updated_at": updated})
}
func (a *App) updateSettings(w http.ResponseWriter, r *http.Request) {
	if !a.checkCSRF(w, r) {
		return
	}
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	var in struct {
		Interval int `json:"qr_interval"`
	}
	if decode(r, &in) != nil || in.Interval < 3 || in.Interval > 60 {
		fail(w, 400, "invalid_input", "QR interval must be between 3 and 60 seconds.")
		return
	}
	_, e := a.db.Exec(`UPDATE settings SET qr_interval=?,schedule_version=schedule_version+1,updated_at=? WHERE id=1`, in.Interval, time.Now().UTC().Format(time.RFC3339Nano))
	if e != nil {
		fail(w, 500, "server_error", "Could not update settings.")
		return
	}
	a.settings(w, r)
}
func (a *App) activateDisplay(w http.ResponseWriter, r *http.Request) {
	if !a.allow("display-provision:"+remoteIP(r.RemoteAddr), 5, time.Hour) {
		fail(w, 429, "rate_limited", "Display provisioning is temporarily rate limited.")
		return
	}
	if !a.checkCSRF(w, r) {
		return
	}
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	var in struct {
		Label string `json:"label"`
	}
	if decode(r, &in) != nil {
		fail(w, 400, "invalid_input", "Enter a display label.")
		return
	}
	if strings.TrimSpace(in.Label) == "" {
		in.Label = "Office entrance"
	}
	raw := token()
	id := randomID()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, e := a.db.Exec(`INSERT INTO displays(id,label,credential_hash,active,created_at) VALUES(?,?,?,1,?)`, id, in.Label, hash(raw), now)
	if e != nil {
		fail(w, 500, "server_error", "Could not activate display.")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "display", Value: raw, Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode, Expires: time.Now().AddDate(1, 0, 0)})
	write(w, 201, map[string]any{"id": id, "label": in.Label})
}
func (a *App) revokeDisplay(w http.ResponseWriter, r *http.Request) {
	if !a.checkCSRF(w, r) {
		return
	}
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	_, e := a.db.Exec(`UPDATE displays SET active=0,revoked_at=? WHERE active=1`, time.Now().UTC().Format(time.RFC3339Nano))
	if e != nil {
		fail(w, 500, "server_error", "Could not revoke display.")
		return
	}
	if c, e := r.Cookie("display"); e == nil {
		_, _ = a.db.Exec(`UPDATE displays SET active=0,revoked_at=? WHERE credential_hash=?`, time.Now().UTC().Format(time.RFC3339Nano), hash(c.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: "display", Value: "", Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	write(w, 200, map[string]string{"status": "revoked"})
}
func challengeToken(displayID string, version int, intervalStart int64) string {
	mac := hmac.New(sha256.New, []byte(env("QR_CHALLENGE_SECRET", "local-development-secret-change-before-deploy")))
	fmt.Fprintf(mac, "%s:%d:%d", displayID, version, intervalStart)
	return hex.EncodeToString(mac.Sum(nil))
}
func (a *App) displayChallenge(w http.ResponseWriter, r *http.Request) {
	c, e := r.Cookie("display")
	if e != nil {
		fail(w, 401, "display_not_provisioned", "Activate this browser as an entrance display from Admin settings.")
		return
	}
	var id, label string
	e = a.db.QueryRow(`SELECT id,label FROM displays WHERE credential_hash=? AND active=1`, hash(c.Value)).Scan(&id, &label)
	if e != nil {
		fail(w, 401, "display_not_provisioned", "This display has been revoked.")
		return
	}
	var interval, version int
	if e = a.db.QueryRow(`SELECT qr_interval,schedule_version FROM settings WHERE id=1`).Scan(&interval, &version); e != nil {
		fail(w, 500, "server_error", "Settings unavailable.")
		return
	}
	now := time.Now().UTC()
	start := now.Unix() / int64(interval) * int64(interval)
	raw := challengeToken(id, version, start)
	overlap := int64(durationEnv("QR_ACCEPTANCE_OVERLAP", 3*time.Second).Seconds())
	expiry := time.Unix(start+int64(interval)+overlap, 0).UTC()
	issued := time.Unix(start, 0).UTC()
	_, e = a.db.Exec(`INSERT OR IGNORE INTO qr_challenges(id,token_hash,display_id,schedule_version,interval_start,issued_at,expires_at) VALUES(?,?,?,?,?,?,?)`, randomID(), hash(raw), id, version, start, issued.Format(time.RFC3339Nano), expiry.Format(time.RFC3339Nano))
	if e != nil {
		fail(w, 500, "server_error", "Could not issue attendance challenge.")
		return
	}
	base := strings.TrimRight(env("PUBLIC_BASE_URL", "http://localhost:8080"), "/")
	write(w, 200, map[string]any{"label": label, "qr_url": base + "/scan?challenge=" + raw, "server_time": now.Format(time.RFC3339Nano), "next_rotation": time.Unix(start+int64(interval), 0).UTC().Format(time.RFC3339Nano), "expires_at": expiry.Format(time.RFC3339Nano), "qr_interval": interval})
}
func (a *App) createAttempt(w http.ResponseWriter, r *http.Request) {
	if !a.allow("scan-exchange:"+remoteIP(r.RemoteAddr), 60, time.Minute) {
		fail(w, 429, "rate_limited", "Too many scan attempts. Wait a minute and try again.")
		return
	}
	if !a.checkCSRF(w, r) {
		return
	}
	a.cleanup()
	var in struct {
		Challenge string `json:"challenge"`
	}
	if decode(r, &in) != nil || len(in.Challenge) < 40 {
		fail(w, 400, "invalid_input", "Scan a valid QR code.")
		return
	}
	var challengeID, displayID, expiry string
	e := a.db.QueryRow(`SELECT c.id,c.display_id,c.expires_at FROM qr_challenges c JOIN settings s ON s.id=1 AND c.schedule_version=s.schedule_version WHERE c.token_hash=?`, hash(in.Challenge)).Scan(&challengeID, &displayID, &expiry)
	expiresAt, parseErr := time.Parse(time.RFC3339Nano, expiry)
	if e != nil || parseErr != nil || !expiresAt.After(time.Now().UTC()) {
		fail(w, 410, "challenge_expired", "This QR code has expired. Scan the refreshed code.")
		return
	}
	flow, e := r.Cookie("flow")
	if e != nil || flow.Value == "" {
		raw := token()
		flow = &http.Cookie{Name: "flow", Value: raw}
		http.SetCookie(w, &http.Cookie{Name: "flow", Value: raw, Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode, Expires: time.Now().Add(10 * time.Minute)})
	}
	fh := hash(flow.Value)
	now := time.Now().UTC()
	_, _ = a.db.Exec(`INSERT OR REPLACE INTO browser_flows(token_hash,created_at,expires_at) VALUES(?,?,?)`, fh, now.Format(time.RFC3339Nano), now.Add(10*time.Minute).Format(time.RFC3339Nano))
	id := randomID()
	deadline := now.Add(durationEnv("PENDING_ATTEMPT_TTL", 2*time.Minute))
	_, e = a.db.Exec(`INSERT INTO attendance_attempts(id,challenge_id,browser_flow_hash,captured_at,expires_at) VALUES(?,?,?,?,?)`, id, challengeID, fh, now.Format(time.RFC3339Nano), deadline.Format(time.RFC3339Nano))
	if e != nil {
		fail(w, 500, "server_error", "Could not create attendance attempt.")
		return
	}
	write(w, 201, map[string]any{"attempt_id": id, "expires_at": deadline.Format(time.RFC3339Nano), "display_id": displayID})
}
func (a *App) completeAttempt(w http.ResponseWriter, r *http.Request) {
	if !a.checkCSRF(w, r) {
		return
	}
	u, ok := a.current(w, r)
	if !ok {
		return
	}
	flow, e := r.Cookie("flow")
	if e != nil {
		fail(w, 403, "attempt_binding_missing", "Rescan the QR code in this browser.")
		return
	}
	id := r.PathValue("id")
	tx, e := a.db.Begin()
	if e != nil {
		fail(w, 500, "server_error", "Could not complete attendance.")
		return
	}
	defer tx.Rollback()
	var fh, captured, expires, displayID, existing, completedUserID string
	e = tx.QueryRow(`SELECT a.browser_flow_hash,a.captured_at,a.expires_at,c.display_id,COALESCE(a.completed_event_id,''),COALESCE(a.completed_user_id,'') FROM attendance_attempts a JOIN qr_challenges c ON c.id=a.challenge_id WHERE a.id=?`, id).Scan(&fh, &captured, &expires, &displayID, &existing, &completedUserID)
	if e != nil || fh != hash(flow.Value) {
		fail(w, 404, "attempt_invalid", "Attendance attempt is unavailable. Rescan the QR code.")
		return
	}
	if existing != "" {
		if completedUserID != u.ID {
			fail(w, 403, "forbidden", "This attendance attempt belongs to another employee.")
			return
		}
		var code string
		_ = tx.QueryRow(`SELECT employee_code_snapshot FROM attendance_events WHERE id=?`, existing).Scan(&code)
		_ = tx.Commit()
		write(w, 200, map[string]any{"event": map[string]any{"id": existing, "employee_code": code, "recorded_at": captured}, "replayed": true})
		return
	}
	attemptExpiry, parseErr := time.Parse(time.RFC3339Nano, expires)
	if parseErr != nil || !attemptExpiry.After(time.Now().UTC()) {
		fail(w, 410, "attempt_expired", "The pending scan expired. Please scan the QR again.")
		return
	}
	eventID := randomID()
	committed := time.Now().UTC().Format(time.RFC3339Nano)
	_, e = tx.Exec(`INSERT INTO attendance_events(id,user_id,employee_code_snapshot,display_id,attempt_id,recorded_at,committed_at) VALUES(?,?,?,?,?,?,?)`, eventID, u.ID, u.EmployeeCode, displayID, id, captured, committed)
	if e == nil {
		_, e = tx.Exec(`UPDATE attendance_attempts SET completed_user_id=?,completed_event_id=? WHERE id=? AND completed_event_id IS NULL`, u.ID, eventID, id)
	}
	if e != nil {
		fail(w, 409, "attempt_completed", "This attendance attempt was already completed.")
		return
	}
	if e = tx.Commit(); e != nil {
		fail(w, 500, "server_error", "Could not commit attendance.")
		return
	}
	write(w, 201, map[string]any{"event": map[string]any{"id": eventID, "employee_code": u.EmployeeCode, "recorded_at": captured}, "replayed": false})
}
