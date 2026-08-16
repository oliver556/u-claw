package modelendpoint

import (
	"net/url"
	"strings"
)

func Valid(raw string) bool {
	endpoint, err := url.Parse(raw)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil ||
		endpoint.Path != "/model-api/" || endpoint.RawPath != "" || endpoint.ForceQuery ||
		endpoint.RawQuery != "" || endpoint.Fragment != "" || strings.HasSuffix(raw, "#") || strings.HasSuffix(raw, "?") {
		return false
	}
	return true
}
