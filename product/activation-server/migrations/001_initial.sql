CREATE TABLE IF NOT EXISTS activation_inventory (
    id UUID PRIMARY KEY,
    username_normalized TEXT UNIQUE NOT NULL,
    username_display TEXT NOT NULL,
    activation_code_digest BYTEA UNIQUE NOT NULL CHECK (octet_length(activation_code_digest) = 32),
    status TEXT NOT NULL CHECK (status IN ('prepared', 'binding', 'active', 'revoked')),
    order_reference TEXT,
    new_api_setup_status TEXT NOT NULL CHECK (new_api_setup_status IN ('pending', 'configured', 'suspended')),
    binding_request_fingerprint BYTEA CHECK (binding_request_fingerprint IS NULL OR octet_length(binding_request_fingerprint) = 32),
    binding_lease_token UUID,
    binding_lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    activated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS devices (
    device_id UUID PRIMARY KEY,
    inventory_id UUID UNIQUE NOT NULL REFERENCES activation_inventory(id),
    fingerprint_version TEXT NOT NULL,
    fingerprint_sha256 BYTEA NOT NULL CHECK (octet_length(fingerprint_sha256) = 32),
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked', 'reissued')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (fingerprint_version, fingerprint_sha256)
);

CREATE TABLE IF NOT EXISTS licenses (
    license_id UUID PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES devices(device_id),
    status TEXT NOT NULL CHECK (status IN ('prepared', 'active', 'disabled', 'revoked', 'expired', 'reissued')),
    revision BIGINT NOT NULL CHECK (revision > 0),
    key_id TEXT NOT NULL,
    startup_secret_salt BYTEA NOT NULL CHECK (octet_length(startup_secret_salt) BETWEEN 16 AND 64),
    startup_secret_hash BYTEA NOT NULL CHECK (octet_length(startup_secret_hash) = 32),
    not_before TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > not_before),
    replacement_license_id UUID REFERENCES licenses(license_id),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (device_id, revision),
    UNIQUE (license_id, device_id),
    CHECK (replacement_license_id IS NULL OR replacement_license_id <> license_id),
    CHECK ((status = 'reissued' AND replacement_license_id IS NOT NULL) OR (status <> 'reissued' AND replacement_license_id IS NULL))
);

CREATE TABLE IF NOT EXISTS activation_attempts (
    activation_id UUID PRIMARY KEY,
    idempotency_key TEXT UNIQUE NOT NULL,
    inventory_id UUID REFERENCES activation_inventory(id),
    device_id UUID REFERENCES devices(device_id),
    license_id UUID REFERENCES licenses(license_id),
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    stage TEXT NOT NULL CHECK (stage IN ('requested', 'server_bound', 'committed', 'failed_before_bind')),
    artifact_envelope BYTEA,
    artifact_key_version TEXT,
    pending_material_envelope BYTEA,
    pending_material_key_version TEXT,
    request_id TEXT NOT NULL CHECK (char_length(request_id) BETWEEN 3 AND 128),
    active_status_event_id UUID NOT NULL,
    bound_audit_event_id UUID NOT NULL,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    committed_at TIMESTAMPTZ,
    CHECK ((artifact_envelope IS NULL) = (artifact_key_version IS NULL)),
    CHECK ((pending_material_envelope IS NULL) = (pending_material_key_version IS NULL))
);

CREATE TABLE IF NOT EXISTS new_api_bindings (
    inventory_id UUID PRIMARY KEY REFERENCES activation_inventory(id),
    device_id UUID UNIQUE REFERENCES devices(device_id),
    new_api_user_id TEXT UNIQUE NOT NULL,
    new_api_username TEXT UNIQUE NOT NULL,
    balance_setup_status TEXT NOT NULL CHECK (balance_setup_status IN ('pending', 'configured', 'suspended')),
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
    policy_digest BYTEA NOT NULL CHECK (octet_length(policy_digest) = 32),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS token_grants (
    jti TEXT PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES devices(device_id),
    license_id UUID NOT NULL,
    policy_digest BYTEA NOT NULL CHECK (octet_length(policy_digest) = 32),
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at),
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (license_id, device_id) REFERENCES licenses(license_id, device_id),
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS audit_events (
    event_id UUID PRIMARY KEY,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('client', 'operator', 'system')),
    actor_id TEXT,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    inventory_id UUID REFERENCES activation_inventory(id),
    device_id UUID REFERENCES devices(device_id),
    license_id UUID REFERENCES licenses(license_id),
    request_id TEXT NOT NULL CHECK (char_length(request_id) BETWEEN 3 AND 128),
    created_at TIMESTAMPTZ NOT NULL,
    CHECK (actor_type = 'system' OR actor_id IS NOT NULL),
    CHECK (num_nonnulls(inventory_id, device_id, license_id, request_id) > 0)
);

CREATE TABLE IF NOT EXISTS license_status_events (
    event_id UUID PRIMARY KEY,
    license_id UUID NOT NULL REFERENCES licenses(license_id),
    revision BIGINT NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked', 'expired', 'reissued')),
    replacement_license_id UUID REFERENCES licenses(license_id),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (license_id, revision),
    CHECK (replacement_license_id IS NULL OR replacement_license_id <> license_id),
    CHECK ((status = 'reissued' AND replacement_license_id IS NOT NULL) OR (status <> 'reissued' AND replacement_license_id IS NULL))
);

CREATE INDEX IF NOT EXISTS activation_attempts_inventory_id_idx ON activation_attempts(inventory_id);
CREATE INDEX IF NOT EXISTS token_grants_device_id_idx ON token_grants(device_id);
CREATE INDEX IF NOT EXISTS audit_events_inventory_id_idx ON audit_events(inventory_id);
CREATE INDEX IF NOT EXISTS audit_events_device_id_idx ON audit_events(device_id);
CREATE INDEX IF NOT EXISTS audit_events_license_id_idx ON audit_events(license_id);
