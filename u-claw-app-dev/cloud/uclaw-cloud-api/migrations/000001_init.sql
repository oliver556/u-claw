-- U-Claw Cloud API initial schema for activation, account mapping, payment, and job/outbox.

CREATE TABLE IF NOT EXISTS uclaw_users (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  phone_verified_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activation_batches (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activation_codes (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT REFERENCES activation_batches(id),
  code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'unused',
  bound_user_id BIGINT REFERENCES uclaw_users(id),
  bound_phone TEXT,
  bound_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_activation_codes_status ON activation_codes(status);
CREATE INDEX IF NOT EXISTS idx_activation_codes_bound_user_id ON activation_codes(bound_user_id);

CREATE TABLE IF NOT EXISTS sms_codes (
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ,
  PRIMARY KEY (phone, purpose)
);

CREATE INDEX IF NOT EXISTS idx_sms_codes_expires_at ON sms_codes(expires_at);

CREATE TABLE IF NOT EXISTS newapi_accounts (
  id BIGSERIAL PRIMARY KEY,
  uclaw_user_id BIGINT NOT NULL UNIQUE REFERENCES uclaw_users(id),
  newapi_base_url TEXT NOT NULL,
  newapi_user_id BIGINT,
  newapi_username TEXT NOT NULL UNIQUE,
  token_fingerprint TEXT,
  token_rotated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_newapi_accounts_user_id ON newapi_accounts(newapi_user_id);

CREATE TABLE IF NOT EXISTS recharge_plans (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  quota_tokens BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_orders (
  id BIGSERIAL PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  uclaw_user_id BIGINT NOT NULL REFERENCES uclaw_users(id),
  plan_id BIGINT REFERENCES recharge_plans(id),
  provider TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  quota_tokens BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  provider_trade_no TEXT,
  paid_at TIMESTAMPTZ,
  credited_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id ON payment_orders(uclaw_user_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status);

CREATE TABLE IF NOT EXISTS payment_callbacks (
  id BIGSERIAL PRIMARY KEY,
  payment_order_id BIGINT REFERENCES payment_orders(id),
  provider TEXT NOT NULL,
  provider_event_id TEXT,
  signature_valid BOOLEAN NOT NULL DEFAULT false,
  payload_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_callbacks_provider_event
  ON payment_callbacks(provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS outbox_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 20,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_jobs_pending
  ON outbox_jobs(status, run_after)
  WHERE status IN ('pending', 'retry');
