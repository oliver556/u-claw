package billing

import "testing"

func TestComputeConversionMatchesBaviBoxPricing(t *testing.T) {
	if ComputeUnitsPerCNY != 6000000 {
		t.Fatalf("ComputeUnitsPerCNY = %d, want 6000000", ComputeUnitsPerCNY)
	}
	if ComputeFromNewAPIQuota(NewAPIQuotaPerCNY) != 6000000 {
		t.Fatalf("one CNY compute = %d, want 6000000", ComputeFromNewAPIQuota(NewAPIQuotaPerCNY))
	}
	if NewAPIQuotaFromCents(1) != 5000 {
		t.Fatalf("one cent quota = %d, want 5000", NewAPIQuotaFromCents(1))
	}
}
