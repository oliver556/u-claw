package billing

const (
	// NewAPIQuotaPerCNY is the New API raw quota amount treated as one CNY.
	NewAPIQuotaPerCNY int64 = 500000
	// ComputeUnitsPerCNY is the Bavi-box user-facing compute amount sold for one CNY.
	ComputeUnitsPerCNY int64 = 6000000
)

// ComputeFromNewAPIQuota converts New API raw quota into Bavi-box compute units.
func ComputeFromNewAPIQuota(quota int64) int64 {
	return quota/NewAPIQuotaPerCNY*ComputeUnitsPerCNY + quota%NewAPIQuotaPerCNY*ComputeUnitsPerCNY/NewAPIQuotaPerCNY
}

// NewAPIQuotaFromCNY converts a CNY amount into the New API raw quota to credit.
func NewAPIQuotaFromCNY(amountCNY int64) int64 {
	return amountCNY * NewAPIQuotaPerCNY
}

// NewAPIQuotaFromCents converts integer CNY cents into the New API raw quota to credit.
func NewAPIQuotaFromCents(amountCents int64) int64 {
	return amountCents * NewAPIQuotaPerCNY / 100
}
