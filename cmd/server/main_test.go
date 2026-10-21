package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	_ "modernc.org/sqlite"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testApp(t *testing.T) (*App, http.Handler) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+randomID()+"?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	if err = initDB(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	a := &App{db: db, secure: false}
	if err = a.seedAdmin(); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	a.routes(mux)
	return a, securityHeaders(mux)
}
func request(t *testing.T, h http.Handler, method, path string, body any, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	var b bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&b).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, "http://example.test"+path, &b)
	for _, c := range cookies {
		r.AddCookie(c)
	}
	if method != "GET" {
		r.Header.Set("Origin", "http://example.test")
		r.Header.Set("X-CSRF-Token", "csrf-test-token")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func TestAdminCanProvisionDisplayAndCompleteBoundAttendanceOnce(t *testing.T) {
	a, h := testApp(t)
	csrf := &http.Cookie{Name: "csrf", Value: "csrf-test-token"}
	login := request(t, h, "POST", "/api/v1/auth/login", map[string]string{"username": "admin", "password": "admin"}, csrf)
	if login.Code != 200 {
		t.Fatalf("login status %d: %s", login.Code, login.Body)
	}
	session := login.Result().Cookies()[0]
	provision := request(t, h, "POST", "/api/v1/admin/display/activate", map[string]string{"label": "Front door"}, csrf, session)
	if provision.Code != 201 {
		t.Fatalf("provision status %d: %s", provision.Code, provision.Body)
	}
	var displayCookie *http.Cookie
	for _, c := range provision.Result().Cookies() {
		if c.Name == "display" {
			displayCookie = c
		}
	}
	if displayCookie == nil {
		t.Fatal("display credential cookie missing")
	}
	challengeRes := request(t, h, "GET", "/api/v1/display/challenge", nil, displayCookie)
	if challengeRes.Code != 200 {
		t.Fatalf("challenge status %d: %s", challengeRes.Code, challengeRes.Body)
	}
	var data map[string]any
	if err := json.Unmarshal(challengeRes.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	qrURL := data["qr_url"].(string)
	token := qrURL[strings.Index(qrURL, "challenge=")+10:]
	exchange := request(t, h, "POST", "/api/v1/attendance/attempts", map[string]string{"challenge": token}, csrf)
	if exchange.Code != 201 {
		t.Fatalf("exchange status %d: %s", exchange.Code, exchange.Body)
	}
	_ = json.Unmarshal(exchange.Body.Bytes(), &data)
	attempt := data["attempt_id"].(string)
	var flow *http.Cookie
	for _, c := range exchange.Result().Cookies() {
		if c.Name == "flow" {
			flow = c
		}
	}
	if flow == nil {
		t.Fatal("browser binding cookie missing")
	}
	complete := request(t, h, "POST", "/api/v1/attendance/attempts/"+attempt+"/complete", map[string]any{}, csrf, session, flow)
	if complete.Code != 201 {
		t.Fatalf("completion status %d: %s", complete.Code, complete.Body)
	}
	retry := request(t, h, "POST", "/api/v1/attendance/attempts/"+attempt+"/complete", map[string]any{}, csrf, session, flow)
	if retry.Code != 200 {
		t.Fatalf("retry status %d: %s", retry.Code, retry.Body)
	}
	var count int
	if err := a.db.QueryRow("SELECT count(*) FROM attendance_events").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("want one event, got %d", count)
	}
}
func TestEmployeeCannotListUsers(t *testing.T) {
	a, h := testApp(t)
	csrf := &http.Cookie{Name: "csrf", Value: "csrf-test-token"}
	_, err := a.db.Exec("INSERT INTO users(id,employee_code,username_normalized,username,display_name,password_hash,role,active,created_at,updated_at) SELECT ?,?,?,?,?,password_hash,'employee',1,created_at,updated_at FROM users WHERE username='admin'", randomID(), "EMP-100", "worker", "worker", "Worker")
	if err != nil {
		t.Fatal(err)
	}
	login := request(t, h, "POST", "/api/v1/auth/login", map[string]string{"username": "worker", "password": "admin"}, csrf)
	if login.Code != 200 {
		t.Fatalf("login status %d: %s", login.Code, login.Body)
	}
	res := request(t, h, "GET", "/api/v1/admin/users", nil, login.Result().Cookies()[0])
	if res.Code != 403 {
		t.Fatalf("expected forbidden, got %d", res.Code)
	}
}
