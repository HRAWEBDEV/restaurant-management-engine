ALTER TABLE "user" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_name" text;--> statement-breakpoint
UPDATE "user" SET
  "first_name" = COALESCE(NULLIF(btrim(split_part("name", ' ', 1)), ''), ''),
  "last_name" = CASE
    WHEN position(' ' in btrim("name")) > 0
      THEN btrim(substring(btrim("name") from position(' ' in btrim("name")) + 1))
    ELSE ''
  END;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "first_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "last_name" SET NOT NULL;
