CREATE TABLE IF NOT EXISTS device_aliases (
    inventory_id UUID NOT NULL,
    device_id UUID NOT NULL,
    target TEXT NOT NULL CHECK (target IN ('win-x64', 'macos-arm64')),
    fingerprint_version TEXT NOT NULL CHECK (fingerprint_version IN ('uclaw-usb-v1', 'uclaw-usb-v2')),
    fingerprint_sha256 BYTEA NOT NULL CHECK (octet_length(fingerprint_sha256) = 32),
    evidence JSONB NOT NULL CHECK (
        jsonb_typeof(evidence) = 'object'
        AND evidence->>'target' = target
        AND NOT (evidence ?| ARRAY['volumeName', 'mountPath', 'driveLetter'])
    ),
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT device_aliases_inventory_target_pk PRIMARY KEY (inventory_id, target),
    CONSTRAINT device_aliases_target_fingerprint_unique UNIQUE (target, fingerprint_version, fingerprint_sha256),
    FOREIGN KEY (device_id, inventory_id) REFERENCES devices(device_id, inventory_id)
);

CREATE INDEX IF NOT EXISTS device_aliases_device_id_idx ON device_aliases(device_id);
