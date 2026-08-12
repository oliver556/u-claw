import type { NewApiManagementClient } from "@uclaw/shared";

import { toRendererSafeError } from "../ipc/client-dispatcher.js";

type UsageRange = { startDate: string; endDate: string };
type UsageRequest =
  | { method: "usage.snapshot"; requestId: string; params: UsageRange }
  | { method: "usage.session-timeseries" | "usage.session-logs"; requestId: string; params: { sessionKey: string } };

interface OpenClawUsageService {
  snapshot(range: UsageRange): Promise<unknown>;
  sessionTimeseries(sessionKey: string): Promise<unknown>;
  sessionLogs(sessionKey: string): Promise<unknown>;
}

interface CreateUsageDispatcherOptions {
  openClaw: OpenClawUsageService;
  newApi?: { userId: string; client: Pick<NewApiManagementClient, "getUsage"> };
  newApiUsage?: () => Promise<Awaited<ReturnType<NewApiManagementClient["getUsage"]>>>;
  now?: () => Date;
}

export function createUsageDispatcher({ openClaw: openClawService, newApi, newApiUsage, now = () => new Date() }: CreateUsageDispatcherOptions) {
  return async (request: UsageRequest) => {
    let result: unknown;
    if (request.method === "usage.snapshot") {
      const [openClaw, newApiResult] = await Promise.all([
        openClawService.snapshot(request.params),
        newApiUsage === undefined && newApi === undefined ? Promise.resolve(null) : (newApiUsage?.() ?? newApi!.client.getUsage(newApi!.userId)).then(
          (quota) => ({ quota }),
          (error: unknown) => ({ error: toRendererSafeError(error) }),
        ),
      ]);
      const fetchedAt = now().toISOString();
      result = {
        fetchedAt,
        range: request.params,
        openClaw,
        newApi: newApiResult === null ? null : "error" in newApiResult ? {
          source: "new-api",
          updatedAt: fetchedAt,
          error: newApiResult.error,
        } : {
          source: "new-api",
          userId: newApiResult.quota.userId,
          quota: newApiResult.quota.consumed + newApiResult.quota.remaining,
          used: newApiResult.quota.consumed,
          remaining: newApiResult.quota.remaining,
          resetAt: newApiResult.quota.resetAt,
          updatedAt: newApiResult.quota.updatedAt,
        },
      };
    } else if (request.method === "usage.session-timeseries") {
      result = await openClawService.sessionTimeseries(request.params.sessionKey);
    } else {
      result = await openClawService.sessionLogs(request.params.sessionKey);
    }
    return { method: request.method, requestId: request.requestId, ok: true as const, result };
  };
}
