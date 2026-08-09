import type { CapabilityRisk, PluginCatalogItem, PluginDetail, PluginIpcRequest, PluginOperation } from "@uclaw/shared";
import { AlertTriangle, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { PluginCard } from "./PluginCard";

let requestSequence = 0;
const nextRequestId = () => `plugin-ui-${++requestSequence}`;
const riskLabel: Record<CapabilityRisk, string> = { low: "低风险", medium: "中风险", high: "高风险", critical: "严重风险" };
const permissionKindLabel = { filesystem: "文件", network: "网络", command: "命令", environment: "环境变量" } as const;

export function PluginManager() {
  const invoke = window.uclaw?.plugins?.invoke;
  const [items, setItems] = useState<PluginCatalogItem[]>([]);
  const [view, setView] = useState<"catalog" | "installed">("catalog");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [repositoryVerified, setRepositoryVerified] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [detail, setDetail] = useState<PluginDetail>();
  const [action, setAction] = useState<"install" | "update" | "enable">("install");
  const [confirmed, setConfirmed] = useState(false);
  const [operations, setOperations] = useState<Record<string, PluginOperation>>({});
  const mounted = useRef(true);
  const loadSequence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const request = (method: PluginIpcRequest["method"], params: Record<string, unknown>) => ({ method, requestId: nextRequestId(), params }) as PluginIpcRequest;

  const load = useCallback(async (nextCursor: string | null = null, append = false) => {
    const sequence = ++loadSequence.current;
    if (!append) setState("loading");
    try {
      if (!invoke) throw new Error();
      const response = view === "catalog"
        ? await invoke(request("plugins.search", { query, cursor: nextCursor, pageSize: 20 }))
        : await invoke(request("plugins.installed", {}));
      if (!response.ok || (view === "catalog" ? response.method !== "plugins.search" : response.method !== "plugins.installed")) throw new Error();
      if (!mounted.current || sequence !== loadSequence.current) return;
      if (response.method === "plugins.search") {
        setItems((current) => append ? [...current, ...response.result.items.filter((item) => !current.some(({ slug }) => slug === item.slug))] : response.result.items);
        setCursor(response.result.nextCursor);
        setHasMore(response.result.hasMore);
        setRepositoryVerified(response.result.repositoryVerified);
      } else {
        setItems(response.result as PluginCatalogItem[]);
        setCursor(null);
        setHasMore(false);
      }
      setState("ready");
    } catch {
      if (mounted.current && sequence === loadSequence.current) setState("error");
    }
  }, [invoke, query, view]);

  useEffect(() => { void load(); }, [load]);

  const openConfirmation = async (item: PluginCatalogItem, nextAction: "install" | "update" | "enable") => {
    if (!invoke) return;
    try {
      const response = await invoke(request("plugins.detail", { slug: item.slug }));
      if (!response.ok || response.method !== "plugins.detail") throw new Error();
      setDetail(response.result);
      setAction(nextAction);
      setConfirmed(false);
    } catch { setState("error"); }
  };

  const poll = async (operation: PluginOperation) => {
    if (!invoke) return;
    let current = operation;
    try {
      while (mounted.current && (current.state === "queued" || current.state === "running")) {
        await new Promise((resolve) => window.setTimeout(resolve, 30));
        const response = await invoke(request("plugins.operation", { operationId: current.id }));
        if (!response.ok || response.method !== "plugins.operation") throw new Error();
        current = response.result;
        setOperations((value) => ({ ...value, [current.slug]: current }));
      }
    } catch {
      current = { ...current, state: "failed", phase: "failed", error: "插件操作中断，请重试。" };
      if (mounted.current) setOperations((value) => ({ ...value, [current.slug]: current }));
    }
    if (current.state === "succeeded") await load();
  };

  const confirmAction = async () => {
    if (!invoke || !detail || !confirmed) return;
    const method = action === "install" ? "plugins.install" : action === "update" ? "plugins.update" : "plugins.set-enabled";
    const response = await invoke(request(method, {
      slug: detail.slug,
      ...(action === "enable" ? { enabled: true } : {}),
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    }));
    if (!response.ok || !["plugins.install", "plugins.update", "plugins.set-enabled"].includes(response.method)) return;
    const operation = response.result as PluginOperation;
    setOperations((value) => ({ ...value, [detail.slug]: operation }));
    setDetail(undefined);
    void poll(operation);
  };

  const simpleAction = async (item: PluginCatalogItem, method: "plugins.uninstall" | "plugins.set-enabled") => {
    if (!invoke) return;
    const params = method === "plugins.uninstall" ? { slug: item.slug } : { slug: item.slug, enabled: false, confirmation: null };
    const response = await invoke(request(method, params));
    if (!response.ok || !["plugins.uninstall", "plugins.set-enabled"].includes(response.method)) return;
    const operation = response.result as PluginOperation;
    setOperations((value) => ({ ...value, [item.slug]: operation }));
    void poll(operation);
  };

  return <section className="plugin-manager" aria-label="插件管理">
    <div className="plugin-view-tabs" role="tablist" aria-label="插件视图">
      <button type="button" role="tab" aria-selected={view === "catalog"} onClick={() => setView("catalog")}>插件目录</button>
      <button type="button" role="tab" aria-selected={view === "installed"} onClick={() => setView("installed")}>已安装</button>
    </div>
    <div className="plugin-toolbar">
      {view === "catalog" ? <label><Search aria-hidden="true" /><span className="sr-only">搜索插件</span><input aria-label="搜索插件" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索插件" /></label> : <strong className="plugin-installed-heading">U 盘已安装插件</strong>}
      <button type="button" aria-label="刷新插件目录" onClick={() => void load()}><RefreshCw aria-hidden="true" /></button>
      {view === "catalog" ? <span className="plugin-mode fixture">{repositoryVerified ? "真实插件仓库" : "Fixture 数据，真实插件仓库未验收"}</span> : null}
    </div>
    {state === "loading" ? <div className="plugin-state"><RefreshCw className="spin" /><strong>正在加载插件目录</strong></div> : null}
    {state === "error" ? <div className="plugin-error" role="alert"><AlertTriangle /><div><strong>插件目录离线</strong><span>可重试目录；已安装插件仍从 U 盘读取。</span></div><button type="button" aria-label="重试插件目录" onClick={() => void load()}>重试</button></div> : null}
    {state === "ready" && items.length === 0 ? <div className="plugin-state"><strong>{view === "catalog" ? "没有匹配的插件" : "尚未安装插件"}</strong><span>{view === "catalog" ? "调整搜索条件后重试。" : "从插件目录安装后会显示在这里。"}</span></div> : null}
    {state === "ready" && items.length > 0 ? <div className="plugin-list" aria-label="插件列表">{items.map((item) => <PluginCard
      key={item.slug}
      item={item}
      operation={operations[item.slug]}
      onConfirm={(nextAction) => void openConfirmation(item, nextAction)}
      onDisable={() => void simpleAction(item, "plugins.set-enabled")}
      onUninstall={() => void simpleAction(item, "plugins.uninstall")}
    />)}</div> : null}
    {state === "ready" && hasMore ? <button className="plugin-load-more" type="button" aria-label="加载更多插件" onClick={() => void load(cursor, true)}>加载更多</button> : null}
    {detail ? <div className="plugin-dialog-backdrop"><div className="plugin-dialog" role="dialog" aria-modal="true" aria-label={`确认${action === "install" ? "安装" : action === "update" ? "更新" : "启用"}${detail.name}`}>
      <header><AlertTriangle /><div><strong>{riskLabel[detail.risk]}插件确认</strong><span>{detail.name}</span></div></header>
      <div className="plugin-risk-flags">{detail.nativeCode ? <strong>原生代码</strong> : null}{detail.commandExecution ? <strong>命令执行</strong> : null}<span>packageKind=plugin</span></div>
      <div className="plugin-dialog-permissions">{detail.permissions.map((permission) => <div key={`${permission.kind}-${permission.target}`}><strong>{permissionKindLabel[permission.kind]} · {permission.target}</strong><span>{permission.reason}</span><em className={`risk-${permission.risk}`}>{riskLabel[permission.risk]}</em></div>)}</div>
      <label className="plugin-risk-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已了解插件高风险权限</label>
      <footer><button type="button" onClick={() => setDetail(undefined)}>取消</button><button type="button" disabled={!confirmed} onClick={() => void confirmAction()}>确认{action === "install" ? "安装" : action === "update" ? "更新" : "启用"}</button></footer>
    </div></div> : null}
  </section>;
}
