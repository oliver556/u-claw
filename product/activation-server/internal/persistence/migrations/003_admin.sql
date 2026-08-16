ALTER TABLE audit_events
    ADD COLUMN IF NOT EXISTS reason TEXT,
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE licenses
    ADD COLUMN IF NOT EXISTS replacement_inventory_id UUID REFERENCES activation_inventory(id);

ALTER TABLE activation_inventory
    ADD COLUMN IF NOT EXISTS replaces_license_id UUID REFERENCES licenses(license_id),
    ADD COLUMN IF NOT EXISTS entitlement_revision BIGINT NOT NULL DEFAULT 1 CHECK (entitlement_revision > 0);

ALTER TABLE licenses DROP CONSTRAINT IF EXISTS licenses_check1;
ALTER TABLE licenses ADD CONSTRAINT licenses_replacement_check CHECK (
    (status = 'reissued' AND num_nonnulls(replacement_license_id, replacement_inventory_id) = 1)
    OR (status <> 'reissued' AND replacement_license_id IS NULL AND replacement_inventory_id IS NULL)
);

ALTER TABLE license_status_events
    ADD COLUMN IF NOT EXISTS replacement_inventory_id UUID REFERENCES activation_inventory(id);
ALTER TABLE license_status_events DROP CONSTRAINT IF EXISTS license_status_events_check1;
ALTER TABLE license_status_events ADD CONSTRAINT license_status_events_replacement_check CHECK (
    (status = 'reissued' AND num_nonnulls(replacement_license_id, replacement_inventory_id) = 1)
    OR (status <> 'reissued' AND replacement_license_id IS NULL AND replacement_inventory_id IS NULL)
);

CREATE TABLE IF NOT EXISTS admin_operations (
    idempotency_key TEXT PRIMARY KEY,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    operator_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL
);
