//go:build !licensefixture

package main

func productionLicenseStatusQuery(string) (func(verifiedLicenseMaterial) (licenseStatusResponse, error), error) {
	return newLicenseStatusHTTPClient(licenseStatusHTTPClientOptions{Endpoint: licenseStatusEndpoint})
}
