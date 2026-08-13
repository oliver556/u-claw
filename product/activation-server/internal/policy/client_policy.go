package policy

type ClientPolicy struct {
	MinimumClientVersion string `json:"minimumClientVersion"`
	UpgradeRequired      bool   `json:"upgradeRequired"`
	FeedURL              string `json:"feedUrl"`
}

func ProductionClientPolicy() ClientPolicy {
	return ClientPolicy{
		MinimumClientVersion: "1.0.0",
		UpgradeRequired:      false,
		FeedURL:              "https://updates.u-claw.org/releases/",
	}
}
