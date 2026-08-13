package modelendpoint

import "testing"

func TestValid(t *testing.T) {
	for _, endpoint := range []string{"https://activation.example/model-api/", "https://192.0.2.10/model-api/"} {
		if !Valid(endpoint) {
			t.Fatalf("valid endpoint rejected: %q", endpoint)
		}
	}
	for _, endpoint := range []string{
		"https://activation.example/model-api%2F",
		"https://activation.example/model-api/?",
		"https://activation.example/model-api/#",
		"https://user:password@activation.example/model-api/",
	} {
		if Valid(endpoint) {
			t.Fatalf("unsafe endpoint accepted: %q", endpoint)
		}
	}
}
