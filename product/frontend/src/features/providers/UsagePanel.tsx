import { Alert, Button, Statistic } from "antd";
import { Activity, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type UsageRequest =
  | { method: "usage.snapshot"; requestId: string; params: { startDate: string; endDate: string } }
  | { method: "usage.session-timeseries" | "usage.session-logs"; requestId: string; params: { sessionKey: string } };
type SessionPoint = { timestamp: number; totalTokens: number; cost: number; cumulativeTokens: number; cumulativeCost: number };
type SessionLog = { timestamp: number; role: string; content: string; tokens?: number; cost?: number };
type UsageResponse = {
  method?: UsageRequest["method"];
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; retryable: boolean };
};
type UsageSnapshot = {
    fetchedAt: string;
    openClaw: {
      providerStatus: {
        updatedAt: number;
        providers: Array<{
          provider: string;
          displayName: string;
          windows: Array<{ label: string; usedPercent: number; resetAt?: number }>;
          billing?: Array<{
            type: "balance" | "spend" | "budget";
            label?: string;
            amount?: number;
            used?: number;
            limit?: number;
            unit: string;
            resetAt?: number;
          }>;
          summary?: string;
          plan?: string;
          error?: string;
        }>;
      };
      cost: { totals: { totalTokens: number; totalCost: number } };
      sessions: { sessions: Array<{ key: string; sessionId: string; modelProvider?: string; model?: string }> };
    };
    newApi: null | {
      source: "new-api";
      updatedAt: string;
      error: { code: string; message: string; retryable: boolean };
    } | {
      source: "new-api";
      quota: number;
      used: number;
      remaining: number;
      resetAt: string | null;
      updatedAt: string;
    };
};

interface UsagePanelProps {
  invoke?: (request: UsageRequest) => Promise<UsageResponse>;
  today?: () => string;
}

let sequence = 0;
const currentDate = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

function defaultInvoke(): UsagePanelProps["invoke"] {
  const bridge = window.uclaw as typeof window.uclaw & { usage?: { invoke(request: UsageRequest): Promise<UsageResponse> } };
  return bridge?.usage?.invoke;
}

function formatTimestamp(value: string | number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZone: "UTC",
  }).format(new Date(value)).replaceAll("/", "-") + " UTC";
}

export function UsagePanel({ invoke = defaultInvoke(), today = currentDate }: UsagePanelProps) {
  const [range, setRange] = useState(() => {
    const date = today();
    return { startDate: date, endDate: date };
  });
  const [draftRange, setDraftRange] = useState(range);
  const [snapshot, setSnapshot] = useState<UsageSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [sessionDetail, setSessionDetail] = useState<{ key: string; points: SessionPoint[]; logs: SessionLog[] }>();
  const [sessionLoading, setSessionLoading] = useState<string>();
  const [sessionError, setSessionError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      if (!invoke) throw new Error("Usage bridge unavailable");
      const response = await invoke({ method: "usage.snapshot", requestId: `usage-${++sequence}`, params: range });
      if (!response.ok || response.result === undefined) {
        setError(response.error?.code ?? "UNKNOWN");
        return;
      }
      setSnapshot(response.result as UsageSnapshot);
      setSessionDetail(undefined);
    } catch {
      setError("UNAVAILABLE");
    } finally {
      setLoading(false);
    }
  }, [invoke, range]);

  useEffect(() => { void load(); }, [load]);

  const loadSession = async (sessionKey: string) => {
    if (!invoke || sessionLoading) return;
    setSessionLoading(sessionKey);
    setSessionError(false);
    try {
      const [timeseries, logs] = await Promise.all([
        invoke({ method: "usage.session-timeseries", requestId: `usage-${++sequence}`, params: { sessionKey } }),
        invoke({ method: "usage.session-logs", requestId: `usage-${++sequence}`, params: { sessionKey } }),
      ]);
      if (!timeseries.ok || !logs.ok) throw new Error("Session usage readback failed");
      setSessionDetail({
        key: sessionKey,
        points: ((timeseries.result as { points?: SessionPoint[] } | undefined)?.points ?? []),
        logs: (logs.result as SessionLog[] | undefined) ?? [],
      });
    } catch {
      setSessionError(true);
    } finally {
      setSessionLoading(undefined);
    }
  };

  if (error) return <Alert type="error" showIcon role="alert" message={`用量读取失败（${error}）`} action={<Button icon={<RefreshCw size={16} />} aria-label="重试用量读取" onClick={() => void load()} />} />;
  if (loading || !snapshot) return <section aria-label="用量与成本">正在读取用量...</section>;

  const providerModels = [...new Set(snapshot.openClaw.sessions.sessions.map(({ modelProvider, model }) =>
    modelProvider && model ? `${modelProvider} / ${model}` : undefined).filter((value): value is string => value !== undefined))];
  return <section className="usage-panel" aria-label="用量与成本">
    <header>
      <h2>用量与成本</h2>
      <input type="date" aria-label="开始日期" value={draftRange.startDate} max={draftRange.endDate} onChange={(event) => setDraftRange((current) => ({ ...current, startDate: event.target.value }))} />
      <input type="date" aria-label="结束日期" value={draftRange.endDate} min={draftRange.startDate} onChange={(event) => setDraftRange((current) => ({ ...current, endDate: event.target.value }))} />
      <Button icon={<RefreshCw size={16} />} aria-label="刷新用量" onClick={() => {
        if (draftRange.startDate === range.startDate && draftRange.endDate === range.endDate) void load();
        else setRange(draftRange);
      }} />
    </header>
    <div className="usage-summary">
      <Statistic title="OpenClaw Token" value={snapshot.openClaw.cost.totals.totalTokens} />
      <Statistic title="估算成本" value={`$${snapshot.openClaw.cost.totals.totalCost.toFixed(2)}`} />
      {snapshot.newApi && !("error" in snapshot.newApi) ? <Statistic title="New API 剩余额度" value={`${snapshot.newApi.remaining.toLocaleString("en-US")} / ${snapshot.newApi.quota.toLocaleString("en-US")}`} /> : null}
    </div>
    <div aria-label="New API 额度">
      {snapshot.newApi === null ? "未配置" : "error" in snapshot.newApi
        ? <Alert type="error" showIcon message={`New API ${snapshot.newApi.error.code}`} />
        : <>{snapshot.newApi.resetAt === null ? "无重置时间" : formatTimestamp(snapshot.newApi.resetAt)}</>}
    </div>
    <div aria-label="OpenClaw Provider 用量">
      {snapshot.openClaw.providerStatus.providers.map((provider) => <div key={provider.provider}>
        <strong>{provider.displayName}</strong>
        {provider.plan ?? ""}{provider.summary ?? ""}
        {provider.windows.map((window) => <span key={window.label}>
          {window.label}{window.usedPercent}%{window.resetAt === undefined ? "" : formatTimestamp(window.resetAt)}
        </span>)}
        {provider.billing?.map((billing, index) => <span key={`${billing.type}-${index}`}>
          {billing.label ?? billing.type}{billing.type === "budget" ? `${billing.used ?? 0} / ${billing.limit ?? 0}` : billing.amount ?? 0} {billing.unit}
          {billing.resetAt === undefined ? "" : formatTimestamp(billing.resetAt)}
        </span>)}
        {provider.error === undefined ? null : <Alert type="error" showIcon role="alert" aria-label={`${provider.displayName} Provider 错误`} message={provider.error} />}
      </div>)}
      <time dateTime={new Date(snapshot.openClaw.providerStatus.updatedAt).toISOString()}>{formatTimestamp(snapshot.openClaw.providerStatus.updatedAt)}</time>
    </div>
    <div aria-label="Provider 归属">{providerModels.length > 0 ? providerModels.join("、") : "暂无会话用量"}</div>
    <div className="usage-session-list" aria-label="会话用量">
      {snapshot.openClaw.sessions.sessions.map((session) => <div key={session.key} className="usage-session-row">
        <span>{session.modelProvider && session.model ? `${session.modelProvider} / ${session.model}` : session.sessionId}</span>
        <Button type="text" loading={sessionLoading === session.key} icon={<Activity size={16} />} aria-label={`查看 ${session.sessionId} 用量`} onClick={() => void loadSession(session.key)} />
      </div>)}
    </div>
    {sessionError ? <Alert type="error" showIcon message="会话用量读取失败" /> : null}
    {sessionDetail ? <div className="usage-session-detail">
      <div aria-label="用量时序">{sessionDetail.points.map((point) => <div key={point.timestamp}>{`${formatTimestamp(point.timestamp)} · ${point.totalTokens.toLocaleString("en-US")} tokens · $${point.cost.toFixed(2)}`}</div>)}</div>
      <div aria-label="用量日志">{sessionDetail.logs.map((log, index) => <div key={`${log.timestamp}-${log.role}-${index}`}>{`${formatTimestamp(log.timestamp)} · ${log.role} · ${(log.tokens ?? 0).toLocaleString("en-US")} tokens`}</div>)}</div>
    </div> : null}
    <time dateTime={snapshot.newApi?.updatedAt ?? snapshot.fetchedAt}>{formatTimestamp(snapshot.newApi?.updatedAt ?? snapshot.fetchedAt)}</time>
  </section>;
}
