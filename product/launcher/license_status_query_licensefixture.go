//go:build licensefixture

package main

func productionLicenseStatusQuery(packageRoot string) (func(verifiedLicenseMaterial) (licenseStatusResponse, error), error) {
	if packageRoot == "" {
		return nil, ErrLicenseLifecycleConfigAbsent
	}
	return func(verifiedLicenseMaterial) (licenseStatusResponse, error) {
		var response licenseStatusResponse
		if err := readStrictLicenseJSON(packageRoot, ".status-response.json", ErrLicenseStatusUnavailable, &response); err != nil {
			if err == ErrLicenseStatusUnavailable {
				return licenseStatusResponse{}, err
			}
			return licenseStatusResponse{}, ErrLicenseStatusResponseInvalid
		}
		return response, nil
	}, nil
}
