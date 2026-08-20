CREATE TABLE production_releases (
    release_sequence BIGINT PRIMARY KEY CHECK (release_sequence BETWEEN 1 AND 9007199254740991),
    release_id TEXT UNIQUE NOT NULL CHECK (release_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
    content_version TEXT NOT NULL,
    release_reason TEXT NOT NULL CHECK (release_reason IN ('release', 'rollback')),
    manifest_url TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
    manifest_readback_verified BOOLEAN NOT NULL,
    cdn_available BOOLEAN NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('current', 'stable', 'withdrawn')),
    content_source_sequence BIGINT NOT NULL CHECK (content_source_sequence > 0),
    rollback_from_sequence BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK ((release_reason = 'rollback') = (rollback_from_sequence IS NOT NULL))
);

CREATE UNIQUE INDEX production_releases_one_current_idx
    ON production_releases ((status)) WHERE status = 'current';

CREATE TABLE production_release_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    policy_epoch BIGINT NOT NULL CHECK (policy_epoch BETWEEN 1 AND 9007199254740991),
    current_sequence BIGINT UNIQUE NOT NULL REFERENCES production_releases(release_sequence),
    previous_stable_sequence BIGINT UNIQUE REFERENCES production_releases(release_sequence),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (previous_stable_sequence IS NULL OR previous_stable_sequence <> current_sequence)
);
