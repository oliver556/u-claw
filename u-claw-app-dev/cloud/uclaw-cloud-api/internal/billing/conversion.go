package billing

const (
	// NewAPIQuotaPerCNY is the New API raw quota amount treated as one CNY.
	NewAPIQuotaPerCNY int64 = 500000
	// ComputeUnitsPerCNY is the U-Claw user-facing compute amount sold for one CNY.
	ComputeUnitsPerCNY int64 = 60000000
)

// ComputeFromNewAPIQuota converts New API raw quota into U-Claw compute units.
func ComputeFromNewAPIQuota(quota int64) int64 {
	return quota/NewAPIQuotaPerCNY*ComputeUnitsPerCNY + quota%NewAPIQuotaPerCNY*ComputeUnitsPerCNY/NewAPIQuotaPerCNY
}

// NewAPIQuotaFromCNY converts a CNY amount into the New API raw quota to credit.
func NewAPIQuotaFromCNY(amountCNY int64) int64 {
	return amountCNY * NewAPIQuotaPerCNY
}
