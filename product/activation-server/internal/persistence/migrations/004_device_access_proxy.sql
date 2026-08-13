CREATE TABLE device_access_tokens (
    device_token_id UUID PRIMARY KEY,
    inventory_id UUID NOT NULL REFERENCES activation_inventory(id),
    device_id UUID NOT NULL REFERENCES devices(device_id),
    license_id UUID NOT NULL,
    token_digest BYTEA UNIQUE NOT NULL CHECK (octet_length(token_digest) = 32),
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
    issued_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (license_id, device_id) REFERENCES licenses(license_id, device_id),
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX device_access_tokens_one_active_per_device_idx
    ON device_access_tokens(device_id) WHERE status = 'active';

ALTER TABLE new_api_bindings
    ADD COLUMN api_key_envelope BYTEA,
    ADD COLUMN api_key_version TEXT,
    ADD COLUMN base_url TEXT,
    ADD COLUMN default_model TEXT,
    ADD COLUMN allowed_models TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN requests_per_minute INTEGER NOT NULL DEFAULT 60,
    ADD COLUMN concurrent_requests INTEGER NOT NULL DEFAULT 2,
    ADD CONSTRAINT new_api_bindings_api_key_pair_check
        CHECK ((api_key_envelope IS NULL) = (api_key_version IS NULL)),
    ADD CONSTRAINT new_api_bindings_requests_per_minute_check
        CHECK (requests_per_minute BETWEEN 1 AND 6000),
    ADD CONSTRAINT new_api_bindings_concurrent_requests_check
        CHECK (concurrent_requests BETWEEN 1 AND 100),
    ADD CONSTRAINT new_api_bindings_configured_proxy_check
        CHECK (
            balance_setup_status <> 'configured'
            OR (
                api_key_envelope IS NULL
                AND api_key_version IS NULL
                AND base_url IS NULL
                AND default_model IS NULL
                AND cardinality(allowed_models) = 0
            )
            OR (
                api_key_envelope IS NOT NULL
                AND api_key_version IS NOT NULL
                AND NULLIF(BTRIM(base_url), '') IS NOT NULL
                AND NULLIF(BTRIM(default_model), '') IS NOT NULL
                AND cardinality(allowed_models) > 0
                AND default_model = ANY(allowed_models)
            )
        ) NOT VALID;

CREATE TABLE model_proxy_admissions (
    request_id UUID PRIMARY KEY,
    device_token_id UUID NOT NULL REFERENCES device_access_tokens(device_token_id),
    started_at TIMESTAMPTZ NOT NULL,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    CHECK (lease_expires_at > started_at)
);

CREATE INDEX model_proxy_admissions_token_started_idx
    ON model_proxy_admissions(device_token_id, started_at DESC);
