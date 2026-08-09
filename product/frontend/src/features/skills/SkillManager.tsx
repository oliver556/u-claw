import type { CapabilityRisk, SkillCatalogItem, SkillDetail, SkillIpcRequest, SkillOperation } from "@uclaw/shared";
import { AlertTriangle, Download, RefreshCw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

let requestSequence = 0;
const nextRequestId = () => `skill-ui-${++requestSequence}`;
const riskLabel: Record<CapabilityRisk, string> = { low: "低风险", medium: "中风险", high: "高风险", critical: "严重风险" };
const permissionKindLabel = { filesystem: "文件", network: "网络", command: "命令", environment: "环境变量" } as const;

export function SkillManager() {
  const invoke = window.uclaw?.skills?.invoke;
  const [items, setItems] = useState<SkillCatalogItem[]>([]);
  const [view, setView] = useState<"catalog" | "installed">("catalog");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [mode, setMode] = useState<"fixture" | "live">("fixture");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [detail, setDetail] = useState<SkillDetail>();
  const [action, setAction] = useState<"install" | "update" | "enable">("install");
  const [confirmed, setConfirmed] = useState(false);
  const [operations, setOperations] = useState<Record<string, SkillOperation>>({});
  const mounted = useRef(true);
  const loadSequence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const request = (method: SkillIpcRequest["method"], params: Record<string, unknown>) => ({ method, requestId: nextRequestId(), params }) as SkillIpcRequest;

  const load = useCallback(async (nextCursor: string | null = null, append = false) => {
    const sequence = ++loadSequence.current;
    if (!append) setState("loading");
    try {
      if (!invoke) throw new Error();
      const response = view === "catalog"
        ? await invoke(request("skills.search", { query, cursor: nextCursor, pageSize: 20 }))
        : await invoke(request("skills.installed", {}));
      if (!response.ok || (view === "catalog" ? response.method !== "skills.search" : response.method !== "skills.installed")) throw new Error();
      if (!mounted.current || sequence !== loadSequence.current) return;
      if (response.method === "skills.search") {
        setItems((current) => append ? [...current, ...response.result.items.filter((item) => !current.some(({ slug }) => slug === item.slug))] : response.result.items);
        setCursor(response.result.nextCursor);
        setHasMore(response.result.hasMore);
        setMode(response.result.mode);
      } else {
        setItems(response.result as SkillCatalogItem[]);
        setCursor(null);
        setHasMore(false);
      }
      setState("ready");
    } catch {
      if (mounted.current && sequence === loadSequence.current) setState("error");
    }
  }, [invoke, query, view]);

  useEffect(() => { void load(); }, [load]);

  const openConfirmation = async (item: SkillCatalogItem, nextAction: "install" | "update" | "enable") => {
    if (!invoke) return;
    try {
      const response = await invoke(request("skills.detail", { slug: item.slug }));
      if (!response.ok || response.method !== "skills.detail") throw new Error();
      setDetail(response.result);
      setAction(nextAction);
      setConfirmed(false);
    } catch { setState("error"); }
  };

  const poll = async (operation: SkillOperation) => {
    if (!invoke) return;
    let current = operation;
    try {
      while (mounted.current && (current.state === "queued" || current.state === "running")) {
        await new Promise((resolve) => window.setTimeout(resolve, 30));
        const response = await invoke(request("skills.operation", { operationId: current.id }));
        if (!response.ok || response.method !== "skills.operation") throw new Error();
        current = response.result;
        setOperations((value) => ({ ...value, [current.slug]: current }));
      }
    } catch {
      current = { ...current, state: "failed", phase: "failed", error: "技能操作中断，请重试。" };
      if (mounted.current) setOperations((value) => ({ ...value, [current.slug]: current }));
    }
    if (current.state === "succeeded") await load();
  };

  const confirmAction = async () => {
    if (!invoke || !detail || !confirmed) return;
    const method = action === "install" ? "skills.install" : action === "update" ? "skills.update" : "skills.set-enabled";
    const params = {
      slug: detail.slug,
      ...(action === "enable" ? { enabled: true } : {}),
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    };
    const response = await invoke(request(method, params));
    if (!response.ok || !["skills.install", "skills.update", "skills.set-enabled"].includes(response.method)) return;
    const operation = response.result as SkillOperation;
    setOperations((value) => ({ ...value, [detail.slug]: operation }));
    setDetail(undefined);
    void poll(operation);
  };

  const simpleAction = async (item: SkillCatalogItem, method: "skills.uninstall" | "skills.set-enabled") => {
    if (!invoke) return;
    const params = method === "skills.uninstall"
      ? { slug: item.slug }
      : { slug: item.slug, enabled: false, confirmation: null };
    const response = await invoke(request(method, params));
    if (!response.ok || !["skills.uninstall", "skills.set-enabled"].includes(response.method)) return;
    const operation = response.result as SkillOperation;
    setOperations((value) => ({ ...value, [item.slug]: operation }));
    void poll(operation);
  };

  return <section className="skill-manager" aria-label="技能管理">
    <div className="skill-view-tabs" role="tablist" aria-label="技能视图">
      <button type="button" role="tab" aria-selected={view === "catalog"} onClick={() => setView("catalog")}>免费目录</button>
      <button type="button" role="tab" aria-selected={view === "installed"} onClick={() => setView("installed")}>已安装</button>
    </div>
    <div className="skill-toolbar">
      {view === "catalog" ? <label><Search aria-hidden="true" /><span className="sr-only">搜索免费技能</span><input aria-label="搜索免费技能" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索免费技能" /></label> : <strong className="skill-installed-heading">U 盘已安装技能</strong>}
      <button type="button" aria-label="刷新技能目录" onClick={() => void load()}><RefreshCw aria-hidden="true" /></button>
      {view === "catalog" ? <span className={`skill-mode ${mode}`}>{mode === "fixture" ? "本地契约数据" : "SkillHub 在线"}</span> : null}
    </div>
    {state === "loading" ? <div className="skill-state"><RefreshCw className="spin" /><strong>正在加载免费技能</strong></div> : null}
    {state === "error" ? <div className="skill-error" role="alert"><AlertTriangle /><div><strong>技能目录离线</strong><span>无法读取免费技能目录。</span></div><button type="button" aria-label="重试技能目录" onClick={() => void load()}>重试</button></div> : null}
    {state === "ready" && items.length === 0 ? <div className="skill-state"><strong>{view === "catalog" ? "没有匹配的免费技能" : "尚未安装技能"}</strong><span>{view === "catalog" ? "调整搜索条件后重试。" : "从免费目录安装后会显示在这里。"}</span></div> : null}
    {state === "ready" && items.length > 0 ? <div className="skill-list" aria-label="免费技能列表">
      {items.map((item) => {
        const operation = operations[item.slug];
        const busy = operation?.state === "queued" || operation?.state === "running";
        return <article className="skill-row" key={item.slug}>
          <div className="skill-identity"><div><strong>{item.name}</strong><span className={`risk-${item.risk}`}>{riskLabel[item.risk]}</span></div><p>{item.description}</p><small>{item.slug} · v{item.version}</small></div>
          <div className="skill-permissions">{item.permissions.map((permission) => <span key={`${permission.kind}-${permission.target}`}>{permissionKindLabel[permission.kind]} · {permission.target}</span>)}</div>
          <div className="skill-actions">
            {item.installedVersion === null ? <button type="button" aria-label={`安装 ${item.name}`} disabled={busy} onClick={() => void openConfirmation(item, "install")}><Download />安装</button> : <>
              {item.updateAvailable ? <button type="button" aria-label={`更新 ${item.name}`} disabled={busy} onClick={() => void openConfirmation(item, "update")}><RefreshCw />更新</button> : null}
              <label className="skill-switch"><input type="checkbox" role="switch" aria-label={`${item.enabled ? "禁用" : "启用"} ${item.name}`} checked={item.enabled} disabled={busy} onChange={() => item.enabled ? void simpleAction(item, "skills.set-enabled") : void openConfirmation(item, "enable")} /><span>{item.enabled ? "已启用" : "已禁用"}</span></label>
              <button type="button" aria-label={`卸载 ${item.name}`} disabled={busy} onClick={() => void simpleAction(item, "skills.uninstall")}><Trash2 />卸载</button>
            </>}
          </div>
          {operation ? <div className={`skill-progress ${operation.state}`}><progress aria-label={`${item.name}操作进度`} aria-valuenow={operation.progress} value={operation.progress} max="100" /><span>{operation.progress}%</span><span>{operation.state === "failed" ? "失败，可重试" : operation.state === "succeeded" ? "完成" : "处理中"}</span></div> : null}
        </article>;
      })}
    </div> : null}
    {state === "ready" && hasMore ? <button className="skill-load-more" type="button" aria-label="加载更多技能" onClick={() => void load(cursor, true)}>加载更多</button> : null}
    {detail ? <div className="skill-dialog-backdrop"><div className="skill-dialog" role="dialog" aria-modal="true" aria-label={`确认${action === "install" ? "安装" : action === "update" ? "更新" : "启用"}${detail.name}`}>
      <header><AlertTriangle /><div><strong>{riskLabel[detail.risk]}权限确认</strong><span>{detail.name}</span></div></header>
      <div className="skill-dialog-permissions">{detail.permissions.map((permission) => <div key={`${permission.kind}-${permission.target}`}><strong>{permissionKindLabel[permission.kind]} · {permission.target}</strong><span>{permission.reason}</span><em className={`risk-${permission.risk}`}>{riskLabel[permission.risk]}</em></div>)}</div>
      <label className="skill-risk-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已了解{riskLabel[detail.risk]}权限</label>
      <footer><button type="button" onClick={() => setDetail(undefined)}>取消</button><button type="button" disabled={!confirmed} onClick={() => void confirmAction()}>确认{action === "install" ? "安装" : action === "update" ? "更新" : "启用"}</button></footer>
    </div></div> : null}
  </section>;
}
