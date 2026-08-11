import type {
  CapabilityRisk,
  SkillCatalogItem,
  SkillCuratorStatus,
  SkillDetail,
  SkillIpcRequest,
  SkillOperation,
  SkillProposalInspect,
  SkillProposalManifest,
  SkillProposalRevisionRun,
  SkillRuntimeInventory,
} from "@uclaw/shared";
import { AlertTriangle, Download, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

let requestSequence = 0;
const nextRequestId = () => `skill-ui-${++requestSequence}`;
const riskLabel: Record<CapabilityRisk, string> = { low: "低风险", medium: "中风险", high: "高风险", critical: "严重风险" };
const permissionKindLabel = { filesystem: "文件", network: "网络", command: "命令", environment: "环境变量" } as const;
const availabilityLabel = { available: "可用", disabled: "已禁用", "missing-dependency": "缺少依赖", conflict: "存在冲突", error: "读取失败" } as const;
type View = "catalog" | "installed" | "runtime" | "curator" | "proposals";
type ProposalForm = "create" | "update" | null;

const messageOf = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

export function SkillManager() {
  const invoke = window.uclaw?.skills?.invoke;
  const mounted = useRef(true);
  const loadSequence = useRef(0);
  const proposalInspectSequence = useRef(0);
  const selectedProposalId = useRef<string | null>(null);
  const mutationPendingRef = useRef(false);
  const [view, setView] = useState<View>("catalog");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [items, setItems] = useState<SkillCatalogItem[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [mode, setMode] = useState<"fixture" | "live">("fixture");
  const [detail, setDetail] = useState<SkillDetail>();
  const [enableConfirmation, setEnableConfirmation] = useState<SkillCatalogItem>();
  const [detailMode, setDetailMode] = useState<"view" | "confirm">("view");
  const [action, setAction] = useState<"install" | "update" | "enable">("install");
  const [confirmed, setConfirmed] = useState(false);
  const [operations, setOperations] = useState<Record<string, SkillOperation>>({});
  const [runtime, setRuntime] = useState<SkillRuntimeInventory>();
  const [curator, setCurator] = useState<SkillCuratorStatus>();
  const [proposals, setProposals] = useState<SkillProposalManifest>();
  const [proposal, setProposal] = useState<SkillProposalInspect>();
  const [proposalForm, setProposalForm] = useState<ProposalForm>(null);
  const [proposalRun, setProposalRun] = useState<SkillProposalRevisionRun>();
  const [mutationPending, setMutationPending] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createContent, setCreateContent] = useState("");
  const [updateName, setUpdateName] = useState("");
  const [updateContent, setUpdateContent] = useState("");
  const [revisionContent, setRevisionContent] = useState("");
  const [revisionInstructions, setRevisionInstructions] = useState("");
  const [sessionKey, setSessionKey] = useState("");
  const [dispositionReason, setDispositionReason] = useState("");

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const request = (method: SkillIpcRequest["method"], params: Record<string, unknown>) => ({ method, requestId: nextRequestId(), params }) as SkillIpcRequest;
  const requireInvoke = () => {
    if (!invoke) throw new Error("技能服务不可用");
    return invoke;
  };
  const requireSuccess = <T,>(response: any, method: SkillIpcRequest["method"]): T => {
    if (!response.ok) throw new Error(response.error.message);
    if (response.method !== method) throw new Error(`技能服务返回错误方法：${response.method}`);
    return response.result as T;
  };

  const load = useCallback(async (nextCursor: string | null = null, append = false) => {
    const sequence = ++loadSequence.current;
    setError("");
    try {
      const call = requireInvoke();
      if (view === "catalog") {
        const response = await call(request("skills.search", { query, category: category || null, cursor: nextCursor, pageSize: 20 }));
        const result = requireSuccess<any>(response, "skills.search");
        if (!mounted.current || sequence !== loadSequence.current) return;
        setItems((current) => append ? [...current, ...result.items.filter((item: SkillCatalogItem) => !current.some(({ slug }) => slug === item.slug))] : result.items);
        setCursor(result.nextCursor);
        setHasMore(result.hasMore);
        setMode(result.mode);
        setCategories((current) => [...new Set([...current, ...result.items.flatMap((item: SkillCatalogItem) => item.categories)])].sort());
      } else if (view === "installed") {
        const response = await call(request("skills.installed", {}));
        const result = requireSuccess<SkillCatalogItem[]>(response, "skills.installed");
        if (!mounted.current || sequence !== loadSequence.current) return;
        setItems(result);
        setCursor(null);
        setHasMore(false);
      } else if (view === "runtime") {
        const response = await call(request("skills.runtime-status", {}));
        const result = requireSuccess<SkillRuntimeInventory>(response, "skills.runtime-status");
        if (!mounted.current || sequence !== loadSequence.current) return;
        setRuntime(result);
      } else if (view === "curator") {
        const response = await call(request("skills.curator-status", {}));
        const result = requireSuccess<SkillCuratorStatus>(response, "skills.curator-status");
        if (!mounted.current || sequence !== loadSequence.current) return;
        setCurator(result);
      } else {
        const response = await call(request("skills.proposals-list", {}));
        const result = requireSuccess<SkillProposalManifest>(response, "skills.proposals-list");
        if (!mounted.current || sequence !== loadSequence.current) return;
        setProposals(result);
      }
      setState("ready");
    } catch (caught) {
      if (mounted.current && sequence === loadSequence.current) {
        setError(messageOf(caught, "技能数据读取失败"));
        setState("error");
      }
    }
  }, [invoke, query, category, view]);

  useEffect(() => { void load(); }, [load]);

  const showError = (caught: unknown, fallback: string) => {
    setError(messageOf(caught, fallback));
  };

  const beginMutation = () => {
    if (mutationPendingRef.current) return false;
    mutationPendingRef.current = true;
    setMutationPending(true);
    return true;
  };

  const endMutation = () => {
    mutationPendingRef.current = false;
    if (mounted.current) setMutationPending(false);
  };

  const openDetail = async (item: SkillCatalogItem, nextMode: "view" | "confirm", nextAction: "install" | "update" = "install") => {
    try {
      const response = await requireInvoke()(request("skills.detail", { slug: item.slug }));
      setDetail(requireSuccess<SkillDetail>(response, "skills.detail"));
      setEnableConfirmation(undefined);
      setDetailMode(nextMode);
      setAction(nextAction);
      setConfirmed(false);
      setError("");
    } catch (caught) { showError(caught, "技能详情读取失败"); }
  };

  const refreshAuthoritativeState = async () => {
    const call = requireInvoke();
    const [installedResponse, runtimeResponse] = await Promise.all([
      call(request("skills.installed", {})),
      call(request("skills.runtime-status", {})),
    ]);
    const installed = requireSuccess<SkillCatalogItem[]>(installedResponse, "skills.installed");
    const nextRuntime = requireSuccess<SkillRuntimeInventory>(runtimeResponse, "skills.runtime-status");
    if (view === "installed") setItems(installed);
    setRuntime(nextRuntime);
  };

  const poll = async (operation: SkillOperation) => {
    let current = operation;
    try {
      const call = requireInvoke();
      while (mounted.current && (current.state === "queued" || current.state === "running")) {
        await new Promise((resolve) => window.setTimeout(resolve, 30));
        const response = await call(request("skills.operation", { operationId: current.id }));
        current = requireSuccess<SkillOperation>(response, "skills.operation");
        setOperations((value) => ({ ...value, [current.slug]: current }));
      }
    } catch (caught) {
      current = { ...current, state: "failed", phase: "failed", error: messageOf(caught, "技能操作中断，请重试。") };
      if (mounted.current) {
        setOperations((value) => ({ ...value, [current.slug]: current }));
        setError(current.error ?? "技能操作失败");
      }
    }
    if (current.state === "failed" && current.error) setError(current.error);
    if (current.state === "succeeded") {
      await load();
      try {
        await refreshAuthoritativeState();
      } catch (caught) {
        showError(caught, "OpenClaw 状态读回失败");
      }
    }
  };

  const startOperation = (operation: SkillOperation) => {
    setOperations((value) => ({ ...value, [operation.slug]: operation }));
    void poll(operation);
  };

  const confirmAction = async () => {
    const selected = action === "enable" ? enableConfirmation : detail;
    if (!selected || !confirmed) return;
    try {
      const method = action === "install" ? "skills.install" : action === "update" ? "skills.update" : "skills.set-enabled";
      const confirmation = {
        permissionFingerprint: selected.permissionFingerprint,
        acceptedRisk: selected.risk,
      };
      const params = action === "enable" ? { slug: selected.slug, enabled: true, confirmation } : { slug: selected.slug, confirmation };
      const response = await requireInvoke()(request(method, params));
      startOperation(requireSuccess<SkillOperation>(response, method));
      setDetail(undefined);
      setEnableConfirmation(undefined);
      setError("");
    } catch (caught) { showError(caught, "技能操作失败"); }
  };

  const simpleAction = async (item: SkillCatalogItem, method: "skills.uninstall" | "skills.set-enabled", enabled = false) => {
    try {
      const params = method === "skills.uninstall" ? { slug: item.slug } : { slug: item.slug, enabled, confirmation: null };
      const response = await requireInvoke()(request(method, params));
      startOperation(requireSuccess<SkillOperation>(response, method));
      setError("");
    } catch (caught) { showError(caught, "技能操作失败"); }
  };

  const toggleAction = (item: SkillCatalogItem) => {
    if (!item.enabled && item.permissions.length > 0) {
      setDetail(undefined);
      setEnableConfirmation(item);
      setDetailMode("confirm");
      setAction("enable");
      setConfirmed(false);
      setError("");
      return;
    }
    void simpleAction(item, "skills.set-enabled", !item.enabled);
  };

  const curatorAction = async (skill: string, actionName: "pin" | "unpin" | "restore") => {
    if (!beginMutation()) return;
    try {
      const response = await requireInvoke()(request("skills.curator-action", { skill, action: actionName }));
      requireSuccess(response, "skills.curator-action");
      setError("");
      await load();
    } catch (caught) { showError(caught, "Curator 操作失败"); }
    finally { endMutation(); }
  };

  const inspectProposal = async (proposalId: string) => {
    selectedProposalId.current = proposalId;
    const sequence = ++proposalInspectSequence.current;
    try {
      const response = await requireInvoke()(request("skills.proposal-inspect", { proposalId }));
      const result = requireSuccess<SkillProposalInspect>(response, "skills.proposal-inspect");
      if (sequence !== proposalInspectSequence.current || selectedProposalId.current !== proposalId) return;
      setProposal(result);
      setRevisionContent(result.content);
      setError("");
    } catch (caught) { showError(caught, "提案读取失败"); }
  };

  const reloadProposals = async () => {
    const response = await requireInvoke()(request("skills.proposals-list", {}));
    setProposals(requireSuccess<SkillProposalManifest>(response, "skills.proposals-list"));
  };

  const submitProposal = async (kind: Exclude<ProposalForm, null>) => {
    if (!beginMutation()) return;
    try {
      const method = kind === "create" ? "skills.proposal-create" : "skills.proposal-update";
      const params = kind === "create"
        ? { name: createName, description: createDescription, content: createContent }
        : { skillName: updateName, content: updateContent };
      const response = await requireInvoke()(request(method, params));
      const result = requireSuccess<SkillProposalInspect>(response, method);
      selectedProposalId.current = result.record.id;
      proposalInspectSequence.current += 1;
      setProposal(result);
      setRevisionContent(result.content);
      setProposalForm(null);
      setError("");
      await reloadProposals();
    } catch (caught) { showError(caught, "提案提交失败"); }
    finally { endMutation(); }
  };

  const reviseProposal = async () => {
    if (!proposal || !beginMutation()) return;
    try {
      const response = await requireInvoke()(request("skills.proposal-revise", { proposalId: proposal.record.id, content: revisionContent }));
      setProposal(requireSuccess<SkillProposalInspect>(response, "skills.proposal-revise"));
      setError("");
      await reloadProposals();
    } catch (caught) { showError(caught, "提案修订失败"); }
    finally { endMutation(); }
  };

  const requestRevision = async () => {
    if (!proposal || !beginMutation()) return;
    try {
      const response = await requireInvoke()(request("skills.proposal-request-revision", {
        proposalId: proposal.record.id,
        instructions: revisionInstructions,
        sessionKey,
      }));
      setProposalRun(requireSuccess<SkillProposalRevisionRun>(response, "skills.proposal-request-revision"));
      setError("");
    } catch (caught) { showError(caught, "请求修订失败"); }
    finally { endMutation(); }
  };

  const disposeProposal = async (actionName: "apply" | "reject" | "quarantine") => {
    if (!proposal || !beginMutation()) return;
    const proposalId = proposal.record.id;
    try {
      const response = await requireInvoke()(request("skills.proposal-action", { proposalId, action: actionName, reason: dispositionReason || null }));
      requireSuccess(response, "skills.proposal-action");
      setError("");
      await reloadProposals();
      if (selectedProposalId.current === proposalId) await inspectProposal(proposalId);
    } catch (caught) { showError(caught, "提案操作失败"); }
    finally { endMutation(); }
  };

  const switchView = (next: View) => {
    setView(next);
    setError("");
    setProposalForm(null);
    if (next !== "proposals") {
      selectedProposalId.current = null;
      proposalInspectSequence.current += 1;
    }
  };

  const dialogSkill = detail ?? enableConfirmation;
  const actionLabel = action === "install" ? "安装" : action === "update" ? "更新" : "启用";

  return <section className="skill-manager" aria-label="技能管理">
    <div className="skill-view-tabs" role="tablist" aria-label="技能视图">
      {([['catalog', '免费目录'], ['installed', '已安装'], ['runtime', '运行状态'], ['curator', 'Curator'], ['proposals', 'Proposals']] as const).map(([id, label]) =>
        <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => switchView(id)}>{label}</button>)}
    </div>

    {(view === "catalog" || view === "installed") ? <>
      <div className="skill-toolbar">
        {view === "catalog" ? <>
          <label><Search aria-hidden="true" /><span className="sr-only">搜索免费技能</span><input aria-label="搜索免费技能" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索免费技能" /></label>
          <label className="skill-category"><span>分类</span><select aria-label="技能分类" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">全部</option>{categories.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        </> : <strong className="skill-installed-heading">U 盘已安装技能</strong>}
        <button type="button" aria-label="刷新技能目录" onClick={() => void load()}><RefreshCw aria-hidden="true" /></button>
        {view === "catalog" ? <span className={`skill-mode ${mode}`}>{mode === "fixture" ? "本地契约数据" : "SkillHub 在线"}</span> : null}
      </div>
      {state === "ready" && items.length === 0 ? <div className="skill-state"><strong>{view === "catalog" ? "没有匹配的免费技能" : "尚未安装技能"}</strong><span>{view === "catalog" ? "调整搜索条件后重试。" : "从免费目录安装后会显示在这里。"}</span></div> : null}
      {state === "ready" && items.length > 0 ? <div className="skill-list" aria-label="免费技能列表">
        {items.map((item) => {
          const operation = operations[item.slug];
          const busy = operation?.state === "queued" || operation?.state === "running";
          return <article className="skill-row" key={item.slug}>
            <div className="skill-identity"><div><strong>{item.name}</strong><span className={`risk-${item.risk}`}>{riskLabel[item.risk]}</span></div><p>{item.description}</p><small>{item.slug} · v{item.version}</small></div>
            <div className="skill-permissions">{item.permissions.map((permission) => <span key={`${permission.kind}-${permission.target}`}>{permissionKindLabel[permission.kind]} · {permission.target}</span>)}</div>
            <div className="skill-actions">
              <button type="button" aria-label={`查看详情 ${item.name}`} onClick={() => void openDetail(item, "view")}>详情</button>
              {item.installedVersion === null ? <button type="button" aria-label={`安装 ${item.name}`} disabled={busy} onClick={() => void openDetail(item, "confirm", "install")}><Download />安装</button> : <>
                {item.updateAvailable ? <button type="button" aria-label={`更新 ${item.name}`} disabled={busy} onClick={() => void openDetail(item, "confirm", "update")}><RefreshCw />更新</button> : null}
                <label className="skill-switch"><input type="checkbox" role="switch" aria-label={`${item.enabled ? "禁用" : "启用"} ${item.name}`} checked={item.enabled} disabled={busy} onChange={() => toggleAction(item)} /><span>{item.enabled ? "已启用" : "已禁用"}</span></label>
                <button type="button" aria-label={`卸载 ${item.name}`} disabled={busy} onClick={() => void simpleAction(item, "skills.uninstall")}><Trash2 />卸载</button>
              </>}
            </div>
            {operation ? <div className={`skill-progress ${operation.state}`}><progress aria-label={`${item.name}操作进度`} aria-valuenow={operation.progress} value={operation.progress} max="100" /><span>{operation.progress}%</span><span>{operation.state === "failed" ? "失败，可重试" : operation.state === "succeeded" ? "完成" : "处理中"}</span>{operation.error ? <span>{operation.error}</span> : null}</div> : null}
          </article>;
        })}
      </div> : null}
      {state === "ready" && hasMore ? <button className="skill-load-more" type="button" aria-label="加载更多技能" onClick={() => void load(cursor, true)}>加载更多</button> : null}
    </> : null}

    {view === "runtime" && state === "ready" ? <div className="skill-runtime-list">
      <div className="skill-meta-line"><span>Workspace · {runtime?.workspaceDir}</span><span>Managed · {runtime?.managedSkillsDir}</span></div>
      {runtime?.skills.map((item, index) => <article className="skill-runtime-row" aria-label={`运行状态 ${item.name}`} key={`${item.id}:${item.source}:${index}`}>
        <header><strong>{item.name}</strong><span>{availabilityLabel[item.availability]}</span><small>{item.source}</small></header>
        {item.description ? <p>{item.description}</p> : null}
        <div className="skill-runtime-flags"><span>{item.availability === "error" ? "状态未知" : item.disabled ? "已禁用" : "已启用"}</span><span>{item.eligible ? "OpenClaw 可用" : "OpenClaw 不可用"}</span><span>{item.bundled ? "内置" : "外部"}</span></div>
        <dl><dt>bins</dt><dd>{item.missing.bins.join(", ") || "-"}</dd><dt>anyBins</dt><dd>{item.missing.anyBins.join(" / ") || "-"}</dd><dt>env</dt><dd>{item.missing.env.join(", ") || "-"}</dd><dt>config</dt><dd>{item.missing.config.join(", ") || "-"}</dd><dt>os</dt><dd>{item.missing.os.join(", ") || "-"}</dd><dt>冲突</dt><dd>{item.conflicts.join(", ") || "-"}</dd></dl>
      </article>)}
    </div> : null}

    {view === "curator" && state === "ready" && curator ? <div className="skill-curator">
      <div className="skill-counts"><strong>活跃 {curator.counts.active}</strong><span>过期 {curator.counts.stale}</span><span>归档 {curator.counts.archived}</span></div>
      {curator.lastError ? <div className="skill-error" role="alert">{curator.lastError}</div> : null}
      <div className="skill-overlaps">{curator.overlaps.map((overlap) => <span key={`${overlap.left}-${overlap.right}`}>{overlap.left} ↔ {overlap.right} · {Math.round(overlap.score * 100)}%</span>)}</div>
      <div className="skill-list">{curator.skills.map((item) => <article className="skill-curator-row" key={item.skillKey}>
        <div><strong>{item.skillName}</strong><span>{item.skillKey} · {item.state} · 使用 {item.useCount}</span>{item.archivedReason ? <small>{item.archivedReason}</small> : null}</div>
        <div className="skill-actions"><button type="button" disabled={mutationPending} aria-label={`${item.pinned ? "取消固定" : "固定"} ${item.skillName}`} onClick={() => void curatorAction(item.skillKey, item.pinned ? "unpin" : "pin")}>{item.pinned ? "取消固定" : "固定"}</button>{item.state === "archived" ? <button type="button" disabled={mutationPending} aria-label={`恢复 ${item.skillName}`} onClick={() => void curatorAction(item.skillKey, "restore")}>恢复</button> : null}</div>
      </article>)}</div>
    </div> : null}

    {view === "proposals" && state === "ready" ? <div className="skill-proposals">
      <div className="skill-section-actions"><button type="button" disabled={mutationPending} onClick={() => setProposalForm("create")}>新建提案</button><button type="button" disabled={mutationPending} onClick={() => setProposalForm("update")}>更新 Skill</button></div>
      {proposalForm === "create" ? <form className="skill-form" onSubmit={(event) => { event.preventDefault(); void submitProposal("create"); }}><label>提案名称<input value={createName} onChange={(event) => setCreateName(event.target.value)} /></label><label>提案描述<input value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} /></label><label>提案内容<textarea value={createContent} onChange={(event) => setCreateContent(event.target.value)} /></label><button type="submit" disabled={mutationPending}>创建提案</button></form> : null}
      {proposalForm === "update" ? <form className="skill-form" onSubmit={(event) => { event.preventDefault(); void submitProposal("update"); }}><label>Skill 名称<input value={updateName} onChange={(event) => setUpdateName(event.target.value)} /></label><label>更新内容<textarea value={updateContent} onChange={(event) => setUpdateContent(event.target.value)} /></label><button type="submit" disabled={mutationPending}>提交更新</button></form> : null}
      <div className="skill-proposal-layout">
        <div className="skill-proposal-list">{proposals?.proposals.map((item) => <article key={item.id}><div><strong>{item.title}</strong><span>{item.kind} · {item.status} · {item.scanState}</span></div><button type="button" aria-label={`查看提案 ${item.title}`} onClick={() => void inspectProposal(item.id)}>查看</button></article>)}</div>
        {proposal ? <div className="skill-proposal-detail">
          <header><div><strong>{proposal.record.title}</strong><span>{proposal.record.proposedVersion} · {proposal.record.status}</span></div><button type="button" aria-label="关闭提案详情" onClick={() => { selectedProposalId.current = null; proposalInspectSequence.current += 1; setProposal(undefined); }}><X /></button></header>
          <div className="skill-scan-summary"><strong>Critical {proposal.record.scan.critical}</strong><span>Warn {proposal.record.scan.warn}</span><span>Info {proposal.record.scan.info}</span></div>
          {proposal.record.scan.findings.map((finding) => <div className="skill-finding" key={`${finding.ruleId}-${finding.file}-${finding.line}`}><strong>{finding.message}</strong><span>{finding.severity} · {finding.file}:{finding.line}</span><code>{finding.evidence}</code></div>)}
          <label>修订内容<textarea value={revisionContent} onChange={(event) => setRevisionContent(event.target.value)} /></label><button type="button" disabled={mutationPending} onClick={() => void reviseProposal()}>提交修订</button>
          <label>修订说明<textarea value={revisionInstructions} onChange={(event) => setRevisionInstructions(event.target.value)} /></label><label>会话 Key<input value={sessionKey} onChange={(event) => setSessionKey(event.target.value)} /></label><button type="button" disabled={mutationPending} onClick={() => void requestRevision()}>请求修订</button>
          {proposalRun ? <span>{proposalRun.runId} · {proposalRun.status}</span> : null}
          <label>处置原因<input value={dispositionReason} onChange={(event) => setDispositionReason(event.target.value)} /></label>
          <div className="skill-section-actions"><button type="button" disabled={mutationPending} onClick={() => void disposeProposal("apply")}>应用提案</button><button type="button" disabled={mutationPending} onClick={() => void disposeProposal("reject")}>拒绝提案</button><button type="button" disabled={mutationPending} onClick={() => void disposeProposal("quarantine")}>隔离提案</button></div>
        </div> : null}
      </div>
    </div> : null}

    {state === "loading" ? <div className="skill-state"><RefreshCw className="spin" /><strong>{view === "catalog" ? "正在加载免费技能" : "正在读取技能数据"}</strong></div> : null}
    {error ? <div className="skill-error" role="alert"><AlertTriangle /><div><strong>{view === "catalog" ? "技能目录离线" : "技能操作失败"}</strong><span>{error}</span></div>{state === "error" ? <button type="button" aria-label="重试技能目录" onClick={() => void load()}>重试</button> : null}</div> : null}

    {dialogSkill ? <div className="skill-dialog-backdrop"><div className="skill-dialog" role="dialog" aria-modal="true" aria-label={detailMode === "view" ? `技能详情 ${dialogSkill.name}` : `确认${actionLabel}${dialogSkill.name}`}>
      <header>{detailMode === "confirm" ? <AlertTriangle /> : null}<div><strong>{detailMode === "view" ? dialogSkill.name : `${riskLabel[dialogSkill.risk]}权限确认`}</strong><span>{detailMode === "view" ? `v${dialogSkill.version} · ${dialogSkill.categories.join(", ")}` : dialogSkill.name}</span></div></header>
      <div className="skill-dialog-permissions">{dialogSkill.permissions.map((permission) => <div key={`${permission.kind}-${permission.target}`}><strong>{permissionKindLabel[permission.kind]} · {permission.target}</strong><span>{permission.reason}</span><em className={`risk-${permission.risk}`}>{riskLabel[permission.risk]}</em></div>)}</div>
      {detailMode === "view" && detail ? <div className="skill-detail-meta"><span>来源 · {detail.source.provider}</span><span>{detail.source.provider === "skillhub" ? detail.source.url : detail.source.origin}</span><span>入口 · {detail.manifest.entry}</span></div> : detailMode === "confirm" ? <label className="skill-risk-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已了解{riskLabel[dialogSkill.risk]}权限</label> : null}
      <footer><button type="button" onClick={() => { setDetail(undefined); setEnableConfirmation(undefined); }}>{detailMode === "view" ? "关闭" : "取消"}</button>{detailMode === "confirm" ? <button type="button" disabled={!confirmed} onClick={() => void confirmAction()}>确认{actionLabel}</button> : null}</footer>
    </div></div> : null}
  </section>;
}
