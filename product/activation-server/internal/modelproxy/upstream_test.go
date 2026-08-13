package modelproxy

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeResolver struct {
	ips []net.IP
	err error
}

func (r fakeResolver) LookupIP(_ context.Context, _ string, _ string) ([]net.IP, error) {
	return r.ips, r.err
}

type fakeDialer struct{ called bool }

func (d *fakeDialer) DialContext(_ context.Context, _, address string) (net.Conn, error) {
	d.called = true
	return nil, errors.New(address)
}

func TestSecureDialRejectsPrivateIPv4IPv6AndMixedAnswers(t *testing.T) {
	for _, ips := range [][]net.IP{{net.ParseIP("127.0.0.1")}, {net.ParseIP("10.0.0.1")}, {net.ParseIP("::1")}, {net.ParseIP("fd00::1")}, {net.ParseIP("8.8.8.8"), net.ParseIP("10.0.0.1")}, {net.ParseIP("203.0.113.8")}} {
		dialer := &fakeDialer{}
		d := SecureDialer(fakeResolver{ips: ips}, dialer)
		_, err := d(context.Background(), "tcp", "api.example.test:443")
		if !errors.Is(err, ErrUnsafeUpstream) {
			t.Fatalf("ips=%v err=%v", ips, err)
		}
		if dialer.called {
			t.Fatal("unsafe address dialed")
		}
	}
}
func TestValidateBaseURLRequiresExactAllowedPublicHostname(t *testing.T) {
	for _, raw := range []string{"http://api.example.test/v1", "https://localhost/v1", "https://127.0.0.1/v1", "https://evil.example.test/v1", "https://api.example.test@evil.test/v1"} {
		if _, err := ValidateBaseURL(raw, []string{"api.example.test"}); !errors.Is(err, ErrUnsafeUpstream) {
			t.Fatalf("raw=%q err=%v", raw, err)
		}
	}
}
func TestClientNeverFollowsRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://elsewhere.invalid", http.StatusFound)
	}))
	defer server.Close()
	client := NewUpstreamClient(server.Client().Transport)
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusFound {
		t.Fatalf("status=%d", response.StatusCode)
	}
}
