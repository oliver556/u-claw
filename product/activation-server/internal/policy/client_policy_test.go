package policy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProductionClientPolicyExposesOnlyReleaseDecisionFields(t *testing.T) {
	encoded, err := json.Marshal(ProductionClientPolicy())
	if err != nil {
		t.Fatal(err)
	}
	const expected = `{"minimumClientVersion":"1.0.0","upgradeRequired":false,"feedUrl":"https://updates.u-claw.org/releases/"}`
	if string(encoded) != expected {
		t.Fatalf("policy=%s", encoded)
	}
	for _, forbidden := range []string{"key", "package", "artifact", "token", "grace"} {
		if strings.Contains(strings.ToLower(string(encoded)), forbidden) {
			t.Fatalf("policy leaks forbidden field %q: %s", forbidden, encoded)
		}
	}
}
