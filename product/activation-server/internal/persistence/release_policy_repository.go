package persistence

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"u-claw-activation-server/internal/policy"
)

const releasePolicyLockID int64 = 0x55434c415752454c

type ReleasePolicyRepository struct{ pool *pgxpool.Pool }

func NewReleasePolicyRepository(pool *pgxpool.Pool) (*ReleasePolicyRepository, error) {
	if pool == nil {
		return nil, errors.New("PostgreSQL pool is required")
	}
	return &ReleasePolicyRepository{pool: pool}, nil
}

func (repository *ReleasePolicyRepository) Production(ctx context.Context) (policy.ProductionState, error) {
	var state policy.ProductionState
	var currentSequence int64
	var previousSequence *int64
	err := repository.pool.QueryRow(ctx, `SELECT policy_epoch,current_sequence,previous_stable_sequence FROM production_release_state WHERE singleton=TRUE`).Scan(&state.PolicyEpoch, &currentSequence, &previousSequence)
	if errors.Is(err, pgx.ErrNoRows) {
		return state, policy.ErrUnavailable
	}
	if err != nil {
		return state, fmt.Errorf("read production release state: %w", err)
	}
	current, err := repository.release(ctx, repository.pool, uint64(currentSequence))
	if err != nil {
		return state, err
	}
	state.Current = &current
	if previousSequence != nil {
		previous, loadErr := repository.release(ctx, repository.pool, uint64(*previousSequence))
		if loadErr != nil {
			return state, loadErr
		}
		state.PreviousStable = &previous
	}
	return state, nil
}

func (repository *ReleasePolicyRepository) Publish(ctx context.Context, release policy.Release) (policy.ProductionState, error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return policy.ProductionState{}, fmt.Errorf("begin release publish: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, releasePolicyLockID); err != nil {
		return policy.ProductionState{}, fmt.Errorf("lock release policy: %w", err)
	}
	var epoch, current uint64
	err = tx.QueryRow(ctx, `SELECT policy_epoch,current_sequence FROM production_release_state WHERE singleton=TRUE FOR UPDATE`).Scan(&epoch, &current)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return policy.ProductionState{}, fmt.Errorf("read release slots: %w", err)
	}
	if err := ensureHigherSequence(ctx, tx, release.ReleaseSequence); err != nil {
		return policy.ProductionState{}, err
	}
	if current != 0 {
		currentRelease, loadErr := repository.release(ctx, tx, current)
		if loadErr != nil || currentRelease.Status != policy.ReleaseStatusCurrent || !currentRelease.ManifestReadbackVerified || !currentRelease.CDNAvailable {
			return policy.ProductionState{}, policy.ErrUnavailable
		}
		result, updateErr := tx.Exec(ctx, `UPDATE production_releases SET status='stable' WHERE release_sequence=$1 AND status='current'`, current)
		if updateErr != nil {
			return policy.ProductionState{}, fmt.Errorf("stabilize current release: %w", updateErr)
		}
		if result.RowsAffected() != 1 {
			return policy.ProductionState{}, policy.ErrUnavailable
		}
	}
	if err = insertRelease(ctx, tx, release, policy.ReleaseStatusCurrent); err != nil {
		return policy.ProductionState{}, err
	}
	if current == 0 {
		_, err = tx.Exec(ctx, `INSERT INTO production_release_state(singleton,policy_epoch,current_sequence,previous_stable_sequence,updated_at) VALUES(TRUE,1,$1,NULL,clock_timestamp())`, release.ReleaseSequence)
		epoch = 1
	} else {
		epoch++
		_, err = tx.Exec(ctx, `UPDATE production_release_state SET policy_epoch=$1,previous_stable_sequence=current_sequence,current_sequence=$2,updated_at=clock_timestamp() WHERE singleton=TRUE`, epoch, release.ReleaseSequence)
	}
	if err != nil {
		return policy.ProductionState{}, fmt.Errorf("switch production release: %w", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return policy.ProductionState{}, fmt.Errorf("commit release publish: %w", err)
	}
	return repository.Production(ctx)
}

func (repository *ReleasePolicyRepository) ForwardRollback(ctx context.Context, release policy.Release) (policy.ProductionState, error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return policy.ProductionState{}, fmt.Errorf("begin release rollback: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, releasePolicyLockID); err != nil {
		return policy.ProductionState{}, fmt.Errorf("lock release policy: %w", err)
	}
	var epoch, current uint64
	var previous *uint64
	err = tx.QueryRow(ctx, `SELECT policy_epoch,current_sequence,previous_stable_sequence FROM production_release_state WHERE singleton=TRUE FOR UPDATE`).Scan(&epoch, &current, &previous)
	if errors.Is(err, pgx.ErrNoRows) || previous == nil {
		return policy.ProductionState{}, policy.ErrPreviousStableUnavailable
	}
	if err != nil {
		return policy.ProductionState{}, fmt.Errorf("read rollback slots: %w", err)
	}
	if err := ensureHigherSequence(ctx, tx, release.ReleaseSequence); err != nil {
		return policy.ProductionState{}, err
	}
	stable, err := repository.release(ctx, tx, *previous)
	if err != nil || stable.Status == policy.ReleaseStatusWithdrawn {
		return policy.ProductionState{}, policy.ErrPreviousStableUnavailable
	}
	release.ContentVersion = stable.ContentVersion
	release.ContentSourceSequence = stable.ReleaseSequence
	release.RollbackFromSequence = current
	release.Reason = policy.ReleaseReasonRollback
	result, updateErr := tx.Exec(ctx, `UPDATE production_releases SET status='withdrawn' WHERE release_sequence=$1 AND status='current'`, current)
	if updateErr != nil {
		return policy.ProductionState{}, fmt.Errorf("withdraw failed release: %w", updateErr)
	}
	if result.RowsAffected() != 1 {
		return policy.ProductionState{}, policy.ErrUnavailable
	}
	if err = insertRelease(ctx, tx, release, policy.ReleaseStatusCurrent); err != nil {
		return policy.ProductionState{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE production_release_state SET policy_epoch=policy_epoch+1,current_sequence=$1,updated_at=clock_timestamp() WHERE singleton=TRUE`, release.ReleaseSequence); err != nil {
		return policy.ProductionState{}, fmt.Errorf("switch rollback release: %w", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return policy.ProductionState{}, fmt.Errorf("commit release rollback: %w", err)
	}
	state, err := repository.Production(ctx)
	if err == nil {
		withdrawn := policy.Release{ReleaseSequence: current, Status: policy.ReleaseStatusWithdrawn}
		state.Withdrawn = &withdrawn
	}
	return state, err
}

type releaseQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (repository *ReleasePolicyRepository) release(ctx context.Context, query releaseQuerier, sequence uint64) (policy.Release, error) {
	var release policy.Release
	err := query.QueryRow(ctx, `SELECT release_sequence,release_id,content_version,release_reason,manifest_url,manifest_sha256,manifest_readback_verified,cdn_available,status,content_source_sequence,COALESCE(rollback_from_sequence,0) FROM production_releases WHERE release_sequence=$1`, sequence).Scan(&release.ReleaseSequence, &release.ReleaseID, &release.ContentVersion, &release.Reason, &release.ManifestURL, &release.ManifestSHA256, &release.ManifestReadbackVerified, &release.CDNAvailable, &release.Status, &release.ContentSourceSequence, &release.RollbackFromSequence)
	if err != nil {
		return release, fmt.Errorf("read release: %w", err)
	}
	return release, nil
}

func ensureHigherSequence(ctx context.Context, tx pgx.Tx, sequence uint64) error {
	var maximum uint64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(max(release_sequence),0) FROM production_releases`).Scan(&maximum); err != nil {
		return fmt.Errorf("read maximum release sequence: %w", err)
	}
	if sequence <= maximum {
		return policy.ErrSequenceRegression
	}
	return nil
}

func insertRelease(ctx context.Context, tx pgx.Tx, release policy.Release, status string) error {
	_, err := tx.Exec(ctx, `INSERT INTO production_releases(release_sequence,release_id,content_version,release_reason,manifest_url,manifest_sha256,manifest_readback_verified,cdn_available,status,content_source_sequence,rollback_from_sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULLIF($11,0))`, release.ReleaseSequence, release.ReleaseID, release.ContentVersion, release.Reason, release.ManifestURL, release.ManifestSHA256, release.ManifestReadbackVerified, release.CDNAvailable, status, release.ContentSourceSequence, release.RollbackFromSequence)
	if err != nil {
		return fmt.Errorf("insert production release: %w", err)
	}
	return nil
}
