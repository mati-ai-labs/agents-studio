ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "previews" jsonb DEFAULT '{}'::jsonb NOT NULL;
