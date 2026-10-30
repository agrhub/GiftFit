CREATE TABLE "metal_wishes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fit_request_id" uuid NOT NULL,
	"catalog_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "hearts_request_catalog_uq";--> statement-breakpoint
ALTER TABLE "fit_requests" ADD COLUMN "metal_lock" text[];--> statement-breakpoint
ALTER TABLE "hearts" ADD COLUMN "variant_id" text;--> statement-breakpoint
ALTER TABLE "metal_wishes" ADD CONSTRAINT "metal_wishes_fit_request_id_fit_requests_id_fk" FOREIGN KEY ("fit_request_id") REFERENCES "public"."fit_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metal_wishes" ADD CONSTRAINT "metal_wishes_catalog_id_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "metal_wishes_request_catalog_uq" ON "metal_wishes" USING btree ("fit_request_id","catalog_id");--> statement-breakpoint
ALTER TABLE "hearts" ADD CONSTRAINT "hearts_request_catalog_variant_uq" UNIQUE NULLS NOT DISTINCT("fit_request_id","catalog_id","variant_id");