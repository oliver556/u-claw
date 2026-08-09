import type {
  DiagnosticLogEntry,
  DiagnosticsIpcRequest,
  DiagnosticsIpcResponse,
  SystemSummary,
} from "@uclaw/shared";
import { Modal, Tooltip } from "antd";
import { AlertTriangle, Copy, Download, FileJson, Pause, Play, RefreshCw, Search, SquareTerminal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type Tab = "logs" | "system" | "config";
type LoadState = "loading" | "ready" | "empty" | "error" | "offline";
type CleanupPreview = Extract<DiagnosticsIpcResponse, { method: "logs.cleanup-preview"; ok: true }>["result"];

let sequence = 0;
let windowSequence = 0;
const request = <T extends DiagnosticsIpcRequest["method"]>(
  method: T,
  params: Extract<DiagnosticsIpcRequest, { method: T }>["params"],
): Extract<DiagnosticsIpcRequest, { method: T }> => ({
  method,
  requestId: `diagnostics-${++sequence}`,
  params,
} as Extract<DiagnosticsIpcRequest, { method: T }>);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function safeMessage(response: DiagnosticsIpcResponse): string {
  return response.ok ? "" : response.error.message;
}

export function SystemDiagnostics() {
  const [tab, setTab] = useState<Tab>("logs");
  const [logs, setLogs] = useState<DiagnosticLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [logState, setLogState] = useState<LoadState>("loading");
  const [system, setSystem] = useState<SystemSummary>();
  const [systemState, setSystemState] = useState<LoadState>("loading");
  const [config, setConfig] = useState<{ content: string; entries: Array<{ path: string; value: string }>; truncated: boolean }>();
  const [configState, setConfigState] = useState<LoadState>("loading");
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("");
  const [source, setSource] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [configQuery, setConfigQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [operation, setOperation] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview>();
  const [retentionDays, setRetentionDays] = useState(7);
  const mounted = useRef(true);

  const invoke = useCallback(async (diagnosticRequest: DiagnosticsIpcRequest): Promise<DiagnosticsIpcResponse> => {
    const bridge = window.uclaw?.diagnostics?.invoke;
    if (!bridge) throw new Error("unavailable");
    return bridge(diagnosticRequest);
  }, []);

  const filterParams = useCallback(() => ({
    limit: 100,
    ...(query.trim() ? { query: query.trim() } : {}),
    ...(level ? { levels: [level as DiagnosticLogEntry["level"]] } : {}),
    ...(source ? { sources: [source as DiagnosticLogEntry["source"]] } : {}),
    ...(from ? { from: new Date(from).toISOString() } : {}),
    ...(to ? { to: new Date(to).toISOString() } : {}),
  }), [from, level, query, source, to]);

  const loadLogs = useCallback(async (cursor?: string, quiet = false) => {
    if (!navigator.onLine) { setLogState("offline"); return; }
    if (!quiet) setLogState("loading");
    try {
      const response = await invoke(request("logs.list", { ...filterParams(), ...(cursor ? { cursor } : {}) }));
      if (!response.ok || response.method !== "logs.list") throw new Error(safeMessage(response));
      if (!mounted.current) return;
      setLogs((current) => cursor ? [...current, ...response.result.items].slice(-500) : response.result.items);
      setNextCursor(response.result.nextCursor);
      setLogState((cursor ? logs.length + response.result.items.length : response.result.items.length) === 0 ? "empty" : "ready");
    } catch { if (mounted.current) setLogState("error"); }
  }, [filterParams, invoke, logs.length]);

  const loadSystem = useCallback(async () => {
    if (!navigator.onLine) { setSystemState("offline"); return; }
    setSystemState("loading");
    try {
      const response = await invoke(request("system.get", {}));
      if (!response.ok || response.method !== "system.get") throw new Error(safeMessage(response));
      if (mounted.current) { setSystem(response.result); setSystemState("ready"); }
    } catch { if (mounted.current) setSystemState("error"); }
  }, [invoke]);

  const loadConfig = useCallback(async () => {
    if (!navigator.onLine) { setConfigState("offline"); return; }
    setConfigState("loading");
    try {
      const response = await invoke(request("config.get", { ...(configQuery.trim() ? { query: configQuery.trim() } : {}) }));
      if (!response.ok || response.method !== "config.get") throw new Error(safeMessage(response));
      if (mounted.current) { setConfig(response.result); setConfigState(response.result.entries.length ? "ready" : "empty"); }
    } catch { if (mounted.current) setConfigState("error"); }
  }, [configQuery, invoke]);

  useEffect(() => {
    mounted.current = true;
    void loadLogs();
    void loadSystem();
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => void loadLogs(undefined, true), 3_000);
    return () => window.clearInterval(timer);
  }, [loadLogs, paused]);

  useEffect(() => { if (tab === "config" && config === undefined) void loadConfig(); }, [config, loadConfig, tab]);

  const exportLogs = async () => {
    setOperation("正在导出脱敏日志"); setNotice(undefined);
    const fileName = `uclaw-diagnostics-${new Date().toISOString().slice(0, 10)}.jsonl`;
    try {
      const response = await invoke(request("logs.export", { fileName, ...filterParams() }));
      setNotice(response.ok && response.method === "logs.export" ? `导出完成：${response.result.name}` : "日志导出失败");
    } catch { setNotice("日志导出失败"); } finally { setOperation(undefined); }
  };

  const previewCleanup = async () => {
    setOperation("正在生成清理预览"); setNotice(undefined);
    try {
      const response = await invoke(request("logs.cleanup-preview", { retentionDays }));
      if (!response.ok || response.method !== "logs.cleanup-preview") throw new Error();
      setCleanupPreview(response.result);
    } catch { setNotice("清理预览失败"); } finally { setOperation(undefined); }
  };

  const confirmCleanup = async () => {
    if (!cleanupPreview) return;
    setOperation("正在清理日志");
    try {
      const response = await invoke(request("logs.cleanup", { previewId: cleanupPreview.previewId, confirm: true }));
      if (!response.ok || response.method !== "logs.cleanup") throw new Error();
      setNotice(response.result.pendingPhysicalFiles
        ? `已隔离 ${response.result.removedFiles} 个日志文件；${response.result.pendingPhysicalFiles} 个等待物理清除`
        : `已清理 ${response.result.removedFiles} 个日志文件`);
      setCleanupPreview(undefined);
      await loadLogs();
    } catch { setNotice("日志清理失败，请重新预览确认当前状态"); } finally { setOperation(undefined); }
  };

  const exportConfig = async () => {
    setOperation("正在导出脱敏配置"); setNotice(undefined);
    const fileName = `openclaw-config-redacted-${new Date().toISOString().slice(0, 10)}.json`;
    try {
      const response = await invoke(request("config.export", { fileName }));
      setNotice(response.ok && response.method === "config.export" ? `配置导出完成：${response.result.name}` : "配置导出失败");
    } catch { setNotice("配置导出失败"); } finally { setOperation(undefined); }
  };

  const copy = (value: string) => void navigator.clipboard?.writeText(value).catch(() => undefined);
  const openAdvancedConsole = async () => {
    const invokeWindow = window.uclaw?.window?.invoke;
    if (!invokeWindow) { setNotice("高级控制台不可用"); return; }
    try {
      const response = await invokeWindow({ method: "open-advanced-console", requestId: `window-${++windowSequence}`, params: {} });
      if (!response.ok) setNotice("高级控制台打开失败");
    } catch { setNotice("高级控制台打开失败"); }
  };
  const stateView = (state: LoadState, empty: string) => state === "loading" ? <div className="diagnostics-state"><RefreshCw className="spin" />正在加载</div>
    : state === "offline" ? <div className="diagnostics-state warning" role="alert"><AlertTriangle />当前离线，诊断数据不可用</div>
    : state === "error" ? <div className="diagnostics-state error" role="alert"><AlertTriangle />诊断数据加载失败<button type="button" onClick={() => tab === "logs" ? void loadLogs() : tab === "system" ? void loadSystem() : void loadConfig()}>重试</button></div>
    : state === "empty" ? <div className="diagnostics-state">{empty}</div> : null;

  const systemRows = system ? [
    ["产品", `${system.product.name} ${system.product.version}`], ["Node", system.runtime.node], ["Electron", system.runtime.electron], ["OpenClaw", system.runtime.openclaw],
    ["平台", `${system.platform} / ${system.architecture}`], ["Gateway", `${system.gateway.status}${system.gateway.port ? ` / ${system.gateway.port}` : ""}`],
    ["代理", system.proxy ?? "未配置"], ["便携数据", `${system.portableData.state}${system.portableData.writable ? " / 可写" : " / 只读"}`],
    ["存储", `${formatBytes(system.storage.usedBytes)} / ${formatBytes(system.storage.totalBytes)}`],
  ] : [];

  return <section className="system-diagnostics secondary-view">
    <header><h1>系统</h1><p>运行状态、日志和诊断</p><button className="secondary-command" type="button" onClick={() => void openAdvancedConsole()}><SquareTerminal />打开高级控制台</button></header>
    <div className="diagnostics-tabs" role="tablist" aria-label="系统诊断视图">
      {[["logs", "日志"], ["system", "系统信息"], ["config", "原始配置"]].map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id as Tab)}>{label}</button>)}
    </div>
    {notice || operation ? <div className="diagnostics-notice" role="status">{operation ?? notice}</div> : null}
    {tab === "logs" ? <div className="diagnostics-content">
      <div className="log-toolbar">
        <label className="diagnostics-search"><Search /><input type="search" aria-label="搜索日志" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索来源、级别或事件" /></label>
        <label><span>级别</span><select aria-label="日志级别" value={level} onChange={(event) => setLevel(event.target.value)}><option value="">全部</option><option value="debug">Debug</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option></select></label>
        <label><span>来源</span><select aria-label="日志来源" value={source} onChange={(event) => setSource(event.target.value)}><option value="">全部</option>{["launcher", "desktop", "adapter", "gateway", "openclaw", "channel"].map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="log-time"><span>开始</span><input type="datetime-local" aria-label="日志开始时间" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label className="log-time"><span>结束</span><input type="datetime-local" aria-label="日志结束时间" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <Tooltip title="应用筛选"><button className="icon-button" type="button" aria-label="应用日志筛选" onClick={() => void loadLogs()}><RefreshCw /></button></Tooltip>
        <Tooltip title={paused ? "恢复刷新" : "暂停刷新"}><button className="icon-button" type="button" aria-label={paused ? "恢复日志刷新" : "暂停日志刷新"} onClick={() => setPaused((value) => !value)}>{paused ? <Play /> : <Pause />}</button></Tooltip>
      </div>
      <div className="diagnostics-actions"><button type="button" onClick={() => void exportLogs()} disabled={Boolean(operation)}><Download />导出脱敏日志</button><label>保留天数<input type="number" min="1" max="3650" value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))} /></label><button type="button" onClick={() => void previewCleanup()} disabled={Boolean(operation)}><Trash2 />预览日志清理</button>{paused ? <span className="paused-state">已暂停</span> : null}</div>
      {stateView(logState, "暂无日志")}
      {logState === "ready" ? <div className="log-list" role="log" aria-label="运行日志">{logs.map((entry) => <article className={`log-row level-${entry.level}`} key={entry.id}><time>{new Date(entry.timestamp).toLocaleString()}</time><span>{entry.level}</span><strong>{entry.source}</strong><p>{entry.message}</p></article>)}{nextCursor ? <button className="diagnostics-more" type="button" aria-label="加载更多日志" onClick={() => void loadLogs(nextCursor)}>加载更多</button> : null}</div> : null}
    </div> : null}
    {tab === "system" ? <div className="diagnostics-content">{stateView(systemState, "暂无系统信息")}{systemState === "ready" ? <div className="system-summary">{systemRows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong><Tooltip title={`复制${label}`}><button type="button" aria-label={`复制${label}`} onClick={() => copy(value)}><Copy /></button></Tooltip></div>)}</div> : null}</div> : null}
    {tab === "config" ? <div className="diagnostics-content"><div className="config-toolbar"><label className="diagnostics-search"><Search /><input type="search" aria-label="搜索配置" value={configQuery} onChange={(event) => setConfigQuery(event.target.value)} placeholder="按字段路径搜索" /></label><button type="button" aria-label="搜索配置" onClick={() => void loadConfig()}><Search />搜索</button><button type="button" aria-label="导出脱敏配置" onClick={() => void exportConfig()} disabled={Boolean(operation)}><Download />导出脱敏配置</button></div>{stateView(configState, "没有匹配配置")}{config ? <div className="config-layout"><div className="config-entries">{config.entries.map((entry) => <button type="button" key={entry.path} onClick={() => copy(`${entry.path}=${entry.value}`)}><span>{entry.path}</span><strong>{entry.value}</strong></button>)}</div><pre aria-label="脱敏配置正文"><FileJson />{config.content}</pre></div> : null}</div> : null}
    <Modal title="确认清理日志" open={cleanupPreview !== undefined} onCancel={() => setCleanupPreview(undefined)} footer={null}>
      {cleanupPreview ? <div className="cleanup-confirm"><p>仅清理 U-Claw 拥有且早于保留策略的日志。</p><strong>{cleanupPreview.files.length} 个文件，{formatBytes(cleanupPreview.totalBytes)}</strong><div>{cleanupPreview.files.map((file) => <span key={file.name}>{file.name}</span>)}</div><footer><button type="button" onClick={() => setCleanupPreview(undefined)}>取消</button><button type="button" aria-label="确认清理" onClick={() => void confirmCleanup()} disabled={Boolean(operation)}>确认清理</button></footer></div> : null}
    </Modal>
  </section>;
}
