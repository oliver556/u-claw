export interface HealthFetchResponse {
  ok: boolean;
}

export interface GatewayHealthDependencies {
  isProcessAlive(): boolean;
  baseUrl: string;
  fetch(url: string, init: { method: "GET"; headers: { accept: "application/json" } }): Promise<HealthFetchResponse>;
  now(): number;
}

export interface GatewayHealthStatus {
  processAlive: boolean;
  serviceReady: boolean;
  businessAvailable: boolean;
  checkedAtMs: number;
}

async function endpointAvailable(
  fetch: GatewayHealthDependencies["fetch"],
  url: string,
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function checkGatewayHealth({
  isProcessAlive,
  baseUrl,
  fetch,
  now,
}: GatewayHealthDependencies): Promise<GatewayHealthStatus> {
  const processAlive = isProcessAlive();
  const checkedAtMs = now();
  if (!processAlive) {
    return { processAlive, serviceReady: false, businessAvailable: false, checkedAtMs };
  }

  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const serviceReady = await endpointAvailable(fetch, `${normalizedBaseUrl}/ready`);
  const businessAvailable = serviceReady
    ? await endpointAvailable(fetch, `${normalizedBaseUrl}/status`)
    : false;
  return { processAlive, serviceReady, businessAvailable, checkedAtMs };
}
