ALTER TABLE activation_attempts
    ADD COLUMN IF NOT EXISTS artifact_generation BIGINT,
    ADD COLUMN IF NOT EXISTS commit_idempotency_key TEXT;

ALTER TABLE activation_attempts
    ADD CONSTRAINT activation_attempts_artifact_generation_check
        CHECK (artifact_generation IS NULL OR artifact_generation > 0),
    ADD CONSTRAINT activation_attempts_committed_fields_check
        CHECK ((stage = 'committed') = (artifact_generation IS NOT NULL AND commit_idempotency_key IS NOT NULL));

ALTER TABLE token_grants
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;
