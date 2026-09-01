ALTER TABLE activation_codes
  ADD COLUMN IF NOT EXISTS newapi_user_group TEXT NOT NULL DEFAULT '';
