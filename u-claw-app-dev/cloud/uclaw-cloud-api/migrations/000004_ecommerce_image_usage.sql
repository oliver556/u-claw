-- Direct ecommerce image generation usage events.
-- Keep this as 000004 because 000003 is already used by activation-code NewAPI group.

CREATE TABLE IF NOT EXISTS ecommerce_image_usage_events (
  id BIGSERIAL PRIMARY KEY,
  uclaw_user_id BIGINT NOT NULL REFERENCES uclaw_users(id),
  newapi_user_id BIGINT NOT NULL,
  phone TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  model_name TEXT NOT NULL,
  token_name TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  output_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_count INTEGER NOT NULL,
  quota_tokens BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recorded',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ecommerce_image_usage_user_created
  ON ecommerce_image_usage_events(uclaw_user_id, created_at DESC);
