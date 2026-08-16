package modelproxy

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var ErrUnsafeUpstream = errors.New("unsafe model upstream")

type Resolver interface {
	LookupIP(context.Context, string, string) ([]net.IP, error)
}
type Dialer interface {
	DialContext(context.Context, string, string) (net.Conn, error)
}

func ValidateBaseURL(raw string, allowed []string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Hostname() == "" || u.Port() != "" || net.ParseIP(u.Hostname()) != nil || strings.EqualFold(u.Hostname(), "localhost") || u.RawQuery != "" || u.Fragment != "" {
		return nil, ErrUnsafeUpstream
	}
	ok := false
	for _, host := range allowed {
		if strings.EqualFold(strings.TrimSuffix(host, "."), strings.TrimSuffix(u.Hostname(), ".")) {
			ok = true
			break
		}
	}
	if !ok {
		return nil, ErrUnsafeUpstream
	}
	return u, nil
}
func publicIP(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	for _, network := range reservedNetworks {
		if network.Contains(ip) {
			return false
		}
	}
	return true
}

var reservedNetworks = func() []*net.IPNet {
	values := []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32", "2002::/16", "fc00::/7", "fec0::/10", "fe80::/10", "ff00::/8"}
	result := make([]*net.IPNet, 0, len(values))
	for _, value := range values {
		_, network, _ := net.ParseCIDR(value)
		result = append(result, network)
	}
	return result
}()

func SecureDialer(resolver Resolver, dialer Dialer) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil || net.ParseIP(host) != nil || strings.EqualFold(host, "localhost") {
			return nil, ErrUnsafeUpstream
		}
		ips, err := resolver.LookupIP(ctx, "ip", host)
		if err != nil || len(ips) == 0 {
			return nil, ErrUnsafeUpstream
		}
		for _, ip := range ips {
			if !publicIP(ip) {
				return nil, ErrUnsafeUpstream
			}
		}
		return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
	}
}
func NewSecureTransport(resolver Resolver, dialer Dialer) *http.Transport {
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	if dialer == nil {
		dialer = &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	}
	return &http.Transport{Proxy: nil, DialContext: SecureDialer(resolver, dialer), TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
}
func NewUpstreamClient(transport http.RoundTripper) *http.Client {
	if transport == nil {
		transport = http.DefaultTransport
	}
	return &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
