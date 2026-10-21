CREATE TABLE "attendance_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"challenge_interval_start" bigint NOT NULL,
	"display_id" uuid NOT NULL,
	"browser_flow_hash" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_user_id" uuid,
	"completed_event_id" uuid
);
--> statement-breakpoint
CREATE TABLE "attendance_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"employee_code_snapshot" text NOT NULL,
	"display_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "attendance_events_attempt_id_unique" UNIQUE("attempt_id")
);
--> statement-breakpoint
CREATE TABLE "browser_flows" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "displays" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"credential_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "displays_credential_hash_unique" UNIQUE("credential_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"qr_interval" integer DEFAULT 5 NOT NULL,
	"schedule_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_qr_interval_check" CHECK ("settings"."qr_interval" between 3 and 60)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"employee_code" text NOT NULL,
	"username" text NOT NULL,
	"username_normalized" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"default_password_pending" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_employee_code_unique" UNIQUE("employee_code"),
	CONSTRAINT "users_username_normalized_unique" UNIQUE("username_normalized"),
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('admin', 'employee'))
);
--> statement-breakpoint
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_attempts_expires_idx" ON "attendance_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "attendance_attempts_flow_idx" ON "attendance_attempts" USING btree ("browser_flow_hash");--> statement-breakpoint
CREATE INDEX "attendance_events_user_time_idx" ON "attendance_events" USING btree ("user_id","recorded_at","id");--> statement-breakpoint
CREATE INDEX "attendance_events_time_idx" ON "attendance_events" USING btree ("recorded_at","id");--> statement-breakpoint
CREATE INDEX "browser_flows_expires_idx" ON "browser_flows" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "displays_active_idx" ON "displays" USING btree ("active");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "users_employee_code_idx" ON "users" USING btree ("employee_code");