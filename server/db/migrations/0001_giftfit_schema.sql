CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"mode" text,
	"feature" text,
	"decision" text,
	"reason" text,
	"units_expected" integer,
	"units_charged" integer,
	"balance_before" numeric(12, 2),
	"run_units" integer,
	"task_id" text,
	"cache_key" text,
	"status" text,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"vertical" text DEFAULT 'jewelry' NOT NULL,
	"title" text NOT NULL,
	"category" text,
	"brand" text,
	"price" numeric(12, 2),
	"currency" text,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_url" text,
	"fetched_at" timestamp with time zone,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fit_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fit_request_id" uuid NOT NULL,
	"items" jsonb NOT NULL,
	"weights" jsonb,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fit_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid,
	"giver_token_hash" text NOT NULL,
	"recipient_token_hash" text NOT NULL,
	"occasion" text,
	"budget_min" numeric(12, 2),
	"budget_max" numeric(12, 2),
	"currency" text,
	"shortlist_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decoy_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone DEFAULT (now() + interval '72 hours') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hearts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fit_request_id" uuid NOT NULL,
	"catalog_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipient_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fit_request_id" uuid NOT NULL,
	"undertone_estimate" text,
	"undertone_confidence" real,
	"undertone_override" text,
	"face_shape" text,
	"has_hand_capture" boolean DEFAULT false NOT NULL,
	"consent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT (now() + interval '72 hours') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retailer_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"catalog_id" uuid,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"dims" jsonb,
	"demo" boolean DEFAULT false NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"platform" text DEFAULT 'unknown' NOT NULL,
	"vertical" text DEFAULT 'jewelry' NOT NULL,
	"ingest_status" text DEFAULT 'pending' NOT NULL,
	"ingest_tier" integer,
	"ingest_progress" jsonb,
	"sku_count" integer DEFAULT 0 NOT NULL,
	"last_ingested_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tryons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cache_key" text NOT NULL,
	"fit_request_id" uuid,
	"catalog_id" uuid,
	"feature" text NOT NULL,
	"task_id" text,
	"result_ref" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"units_charged" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT (now() + interval '72 hours') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "youcam_results" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"feature" text NOT NULL,
	"task_id" text NOT NULL,
	"result" jsonb NOT NULL,
	"units_charged" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "catalog" ADD CONSTRAINT "catalog_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fit_reports" ADD CONSTRAINT "fit_reports_fit_request_id_fit_requests_id_fk" FOREIGN KEY ("fit_request_id") REFERENCES "public"."fit_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fit_requests" ADD CONSTRAINT "fit_requests_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearts" ADD CONSTRAINT "hearts_fit_request_id_fit_requests_id_fk" FOREIGN KEY ("fit_request_id") REFERENCES "public"."fit_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearts" ADD CONSTRAINT "hearts_catalog_id_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipient_profiles" ADD CONSTRAINT "recipient_profiles_fit_request_id_fit_requests_id_fk" FOREIGN KEY ("fit_request_id") REFERENCES "public"."fit_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retailer_metrics" ADD CONSTRAINT "retailer_metrics_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retailer_metrics" ADD CONSTRAINT "retailer_metrics_catalog_id_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tryons" ADD CONSTRAINT "tryons_fit_request_id_fit_requests_id_fk" FOREIGN KEY ("fit_request_id") REFERENCES "public"."fit_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tryons" ADD CONSTRAINT "tryons_catalog_id_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."catalog"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_ts_idx" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_log_feature_idx" ON "audit_log" USING btree ("feature","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_store_external_uq" ON "catalog" USING btree ("store_id","external_id");--> statement-breakpoint
CREATE INDEX "catalog_store_category_idx" ON "catalog" USING btree ("store_id","category");--> statement-breakpoint
CREATE INDEX "catalog_attributes_gin" ON "catalog" USING gin ("attributes");--> statement-breakpoint
CREATE INDEX "catalog_embedding_hnsw" ON "catalog" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "fit_reports_request_uq" ON "fit_reports" USING btree ("fit_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fit_requests_giver_token_uq" ON "fit_requests" USING btree ("giver_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "fit_requests_recipient_token_uq" ON "fit_requests" USING btree ("recipient_token_hash");--> statement-breakpoint
CREATE INDEX "fit_requests_store_idx" ON "fit_requests" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "fit_requests_expires_idx" ON "fit_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hearts_request_catalog_uq" ON "hearts" USING btree ("fit_request_id","catalog_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipient_profiles_request_uq" ON "recipient_profiles" USING btree ("fit_request_id");--> statement-breakpoint
CREATE INDEX "recipient_profiles_expires_idx" ON "recipient_profiles" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "retailer_metrics_store_metric_idx" ON "retailer_metrics" USING btree ("store_id","metric","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_url_uq" ON "stores" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "tryons_request_cache_key_uq" ON "tryons" USING btree ("fit_request_id","cache_key");--> statement-breakpoint
CREATE INDEX "tryons_request_idx" ON "tryons" USING btree ("fit_request_id");--> statement-breakpoint
CREATE INDEX "youcam_results_expires_idx" ON "youcam_results" USING btree ("expires_at");