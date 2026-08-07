export interface HealthFetchResponse {
  ok: boolean;
}

export interface GatewayHealthDependencies {
  isProcessAlive(): boolean;
  baseUrl: string;
  fetch(url: string, init: { method: "GET"; headers: { accept: "application/json" } }): Promise<HealthFetchResponse>;
  now(): number;
  requiredMethods?: readonly string[];
  probeCapabilities?(): Promise<GatewayCapabilityProbeResult>;
}

export interface GatewayCapabilityProbeResult {
  helloOk: boolean;
  methods: readonly string[] | ReadonlySet<string>;
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

async function probeBusinessAvailability(
  probeCapabilities: GatewayHealthDependencies["probeCapabilities"],
  requiredMethods: readonly string[],
): Promise<boolean> {
  if (!probeCapabilities) return false;
  try {
    const result = await probeCapabilities();
    if (!result.helloOk) return false;
    const methods = result.methods instanceof Set
      ? result.methods
      : new Set(result.methods);
    return requiredMethods.every((method) => methods.has(method));
  } catch {
    return false;
  }
}

export async function checkGatewayHealth({
  isProcessAlive,
  baseUrl,
  fetch,
  now,
  requiredMethods = [],
  probeCapabilities,
}: GatewayHealthDependencies): Promise<GatewayHealthStatus> {
  const processAlive = isProcessAlive();
  const checkedAtMs = now();
  if (!processAlive) {
    return { processAlive, serviceReady: false, businessAvailable: false, checkedAtMs };
  }

  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const serviceReady = await endpointAvailable(fetch, `${normalizedBaseUrl}/ready`);
  const businessAvailable = serviceReady
    ? await probeBusinessAvailability(probeCapabilities, requiredMethods)
    : false;
  return { processAlive, serviceReady, businessAvailable, checkedAtMs };
}
