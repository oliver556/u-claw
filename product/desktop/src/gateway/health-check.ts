export interface HealthFetchResponse {
  ok: boolean;
}

export interface GatewayHealthDependencies {
  isProcessAlive(): boolean;
  baseUrl: string;
  fetch(url: string, init: {
    method: "GET";
    headers: { accept: "application/json" };
    signal: AbortSignal;
  }): Promise<HealthFetchResponse>;
  now(): number;
  deadlineMs: number;
  signal: AbortSignal;
  requiredMethods?: readonly string[];
  probeCapabilities?(signal: AbortSignal): Promise<GatewayCapabilityProbeResult>;
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
  now: () => number,
  deadlineMs: number,
  parentSignal: AbortSignal,
): Promise<boolean> {
  try {
    const response = await withDeadline(
      (signal) => fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal,
      }),
      now,
      deadlineMs,
      parentSignal,
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function probeBusinessAvailability(
  probeCapabilities: GatewayHealthDependencies["probeCapabilities"],
  requiredMethods: readonly string[],
  now: () => number,
  deadlineMs: number,
  parentSignal: AbortSignal,
): Promise<boolean> {
  if (!probeCapabilities) return false;
  try {
    const result = await withDeadline(probeCapabilities, now, deadlineMs, parentSignal);
    if (!result.helloOk) return false;
    const methods = result.methods instanceof Set
      ? result.methods
      : new Set(result.methods);
    return requiredMethods.every((method) => methods.has(method));
  } catch {
    return false;
  }
}

async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  now: () => number,
  deadlineMs: number,
  parentSignal: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, parentSignal]);
  const remainingMs = Math.max(0, deadlineMs - now());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Gateway health check timed out."));
    }, remainingMs);
  });
  let rejectAbort!: (error: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(signal.reason ?? new DOMException("Aborted", "AbortError"));
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation(signal), deadline, aborted]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

export async function checkGatewayHealth({
  isProcessAlive,
  baseUrl,
  fetch,
  now,
  deadlineMs,
  signal,
  requiredMethods = [],
  probeCapabilities,
}: GatewayHealthDependencies): Promise<GatewayHealthStatus> {
  const processAlive = isProcessAlive();
  const checkedAtMs = now();
  if (!processAlive) {
    return { processAlive, serviceReady: false, businessAvailable: false, checkedAtMs };
  }

  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const serviceReady = await endpointAvailable(
    fetch,
    `${normalizedBaseUrl}/ready`,
    now,
    deadlineMs,
    signal,
  );
  if (!isProcessAlive()) {
    return { processAlive: false, serviceReady: false, businessAvailable: false, checkedAtMs };
  }
  const businessAvailable = serviceReady
    ? await probeBusinessAvailability(probeCapabilities, requiredMethods, now, deadlineMs, signal)
    : false;
  const sameProcessAlive = isProcessAlive();
  return sameProcessAlive
    ? { processAlive: true, serviceReady, businessAvailable, checkedAtMs }
    : { processAlive: false, serviceReady: false, businessAvailable: false, checkedAtMs };
}
