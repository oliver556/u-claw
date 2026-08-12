import {
  McpServerDraftSchema,
  McpServerUpdatePatchSchema,
  type CapabilityToolsSnapshot,
  type ExecApprovalPolicySnapshot,
  type ManagedMcpServerSummary,
  type McpIpcRequest,
  type McpSnapshot,
  type McpTransport,
} from "@uclaw/shared";
import { Alert, Button, Input, Modal, Popconfirm, Switch, Tag, Tooltip } from "antd";
import { CircleOff, Pencil, Plus, RefreshCw, RotateCw, Server, TestTube2, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type FormState = {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  url: string;
  authenticationType: "none" | "bearer" | "header";
  headerName: string;
  secret: string;
  executableId: "node" | "npx" | "python" | "uvx";
  args: string;
  env: string;
  clearArgs: boolean;
  clearEnv: boolean;
};

const emptyForm: FormState = {
  id: "", name: "", transport: "streamable-http", enabled: true, url: "",
  authenticationType: "none", headerName: "", secret: "", executableId: "node", args: "", env: "",
  clearArgs: false, clearEnv: false,
};

const statusLabels: Record<ManagedMcpServerSummary["status"], string> = {
  disabled: "已停用", disconnected: "未连接", connecting: "连接中", connected: "已连接", error: "错误", unavailable: "不可用",
};
const statusColors: Record<ManagedMcpServerSummary["status"], string> = {
  disabled: "default", disconnected: "default", connecting: "processing", connected: "success", error: "error", unavailable: "warning",
};

let requestSequence = 0;
function request(method: McpIpcRequest["method"], params: Record<string, unknown>): McpIpcRequest {
  requestSequence += 1;
  return { method, requestId: `mcp-ui-${requestSequence}`, params } as McpIpcRequest;
}

function draftFromForm(form: FormState): unknown {
  if (form.transport === "stdio") {
    const env = Object.fromEntries(form.env.split(/\r?\n/u).filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      return separator < 1 ? [line, ""] : [line.slice(0, separator).trim(), line.slice(separator + 1)];
    }));
    return {
      id: form.id.trim(), name: form.name.trim(), enabled: form.enabled, transport: "stdio",
      executableId: form.executableId, args: form.args.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean), env,
    };
  }
  const authentication = form.authenticationType === "none"
    ? { type: "none" }
    : form.authenticationType === "bearer"
      ? { type: "bearer", ...(form.secret ? { secret: form.secret } : {}) }
      : { type: "header", headerName: form.headerName.trim(), ...(form.secret ? { secret: form.secret } : {}) };
  return {
    id: form.id.trim(), name: form.name.trim(), enabled: form.enabled, transport: form.transport,
    url: form.url.trim(), authentication,
  };
}

function updatePatchFromForm(form: FormState): unknown {
  if (form.transport === "stdio") {
    const env = Object.fromEntries(form.env.split(/\r?\n/u).filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      return separator < 1 ? [line, ""] : [line.slice(0, separator).trim(), line.slice(separator + 1)];
    }));
    return {
      id: form.id.trim(), name: form.name.trim(), enabled: form.enabled, transport: "stdio",
      executableId: form.executableId,
      ...(form.clearArgs ? { args: [] } : form.args ? { args: form.args.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean) } : {}),
      ...(form.clearEnv ? { env: {} } : form.env ? { env } : {}),
    };
  }
  const authentication = form.authenticationType === "none"
    ? { type: "none" }
    : form.authenticationType === "bearer"
      ? { type: "bearer", ...(form.secret ? { secret: form.secret } : {}) }
      : { type: "header", headerName: form.headerName.trim(), ...(form.secret ? { secret: form.secret } : {}) };
  return {
    id: form.id.trim(), name: form.name.trim(), enabled: form.enabled, transport: form.transport,
    ...(form.url ? { url: form.url.trim() } : {}), authentication,
  };
}

export function McpManager() {
  const [panel, setPanel] = useState<"servers" | "tools" | "approvals">("servers");
  const [snapshot, setSnapshot] = useState<McpSnapshot>();
  const [tools, setTools] = useState<CapabilityToolsSnapshot>();
  const [approval, setApproval] = useState<ExecApprovalPolicySnapshot>();
  const [capabilityError, setCapabilityError] = useState(false);
  const [approvalSaved, setApprovalSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [operationError, setOperationError] = useState(false);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedMcpServerSummary>();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<string>();
  const [riskServer, setRiskServer] = useState<ManagedMcpServerSummary>();
  const [riskAccepted, setRiskAccepted] = useState(false);
  const invoke = window.uclaw?.mcp?.invoke;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    if (!invoke) { setLoadError(true); setLoading(false); return; }
    try {
      const response = await invoke(request("mcp.list", {}));
      if (!response.ok || response.method !== "mcp.list") throw new Error();
      setSnapshot(response.result);
    } catch { setLoadError(true); }
    finally { setLoading(false); }
  }, [invoke]);

  useEffect(() => { void load(); }, [load]);

  const loadTools = async () => {
    if (!invoke) return;
    setCapabilityError(false);
    try {
      const response = await invoke(request("capabilities.tools", { agentId: "main", sessionKey: "agent:main:main" }));
      if (!response.ok || response.method !== "capabilities.tools") throw new Error();
      setTools(response.result);
    } catch { setCapabilityError(true); }
  };

  const loadApproval = async () => {
    if (!invoke) return;
    setCapabilityError(false);
    setApprovalSaved(false);
    try {
      const response = await invoke(request("capabilities.approvals-get", {}));
      if (!response.ok || response.method !== "capabilities.approvals-get") throw new Error();
      setApproval(response.result);
    } catch { setCapabilityError(true); }
  };

  const saveApproval = async () => {
    if (!invoke || !approval) return;
    setCapabilityError(false);
    setApprovalSaved(false);
    try {
      const response = await invoke(request("capabilities.approvals-set", { baseHash: approval.hash, policy: approval.policy }));
      if (!response.ok || response.method !== "capabilities.approvals-set") throw new Error();
      setApproval(response.result);
      setApprovalSaved(true);
    } catch { setCapabilityError(true); }
  };

  const mutate = async (serverId: string, operation: string, operationRequest: McpIpcRequest) => {
    if (!invoke || busy[serverId]) return false;
    setBusy((current) => ({ ...current, [serverId]: operation }));
    setOperationError(false);
    try {
      const response = await invoke(operationRequest);
      if (!response.ok) throw new Error();
      if (response.method === "mcp.test" || response.method === "mcp.reconnect") {
        setSnapshot((current) => current ? { ...current, servers: current.servers.map((server) => server.id === response.result.id ? response.result : server) } : current);
      } else if (["mcp.create", "mcp.update", "mcp.remove", "mcp.set-enabled", "mcp.confirm-risk"].includes(response.method)) {
        setSnapshot(response.result as McpSnapshot);
      }
      return true;
    } catch { setOperationError(true); return false; }
    finally { setBusy((current) => { const next = { ...current }; delete next[serverId]; return next; }); }
  };

  const openCreate = () => { setEditing(undefined); setForm(emptyForm); setFormError(undefined); setFormOpen(true); };
  const openEdit = (server: ManagedMcpServerSummary) => {
    setEditing(server);
    setForm({
      ...emptyForm, id: server.id, name: server.name, enabled: server.enabled, transport: server.transport,
      ...(server.transport === "stdio" ? { executableId: server.executableId } : {
        authenticationType: server.authentication.type,
        ...(server.authentication.type === "header" ? { headerName: server.authentication.headerName } : {}),
      }),
    });
    setFormError(undefined);
    setFormOpen(true);
  };
  const save = async () => {
    const parsed = editing
      ? McpServerUpdatePatchSchema.safeParse(updatePatchFromForm(form))
      : McpServerDraftSchema.safeParse(draftFromForm(form));
    if (!parsed.success) { setFormError("请检查 ID、名称和 transport 配置。路径、命令或环境变量可能被安全策略拒绝。"); return; }
    const operationRequest = editing
      ? request("mcp.update", { serverId: editing.id, server: parsed.data })
      : request("mcp.create", { server: parsed.data });
    if (await mutate(editing?.id ?? parsed.data.id, operationRequest.requestId, operationRequest)) setFormOpen(false);
    else setFormError("MCP server 保存失败，请重试。");
  };

  const confirmRisk = async () => {
    if (riskServer?.transport !== "stdio" || !riskServer.riskFingerprint) return;
    const operationRequest = request("mcp.confirm-risk", { serverId: riskServer.id, fingerprint: riskServer.riskFingerprint, confirmed: true });
    if (await mutate(riskServer.id, operationRequest.requestId, operationRequest)) setRiskServer(undefined);
    setRiskAccepted(false);
  };

  const runtimeUnavailable = snapshot?.runtime.state === "unavailable";
  return <section className="secondary-view mcp-settings">
    <header className="mcp-page-header"><div><h1>MCP、工具与审批</h1><p>配置、实时状态与有效权限分层管理</p></div>{panel === "servers" ? <Button type="primary" icon={<Plus />} aria-label="新增 MCP server" onClick={openCreate}>新增 server</Button> : null}</header>
    <div className="secondary-content mcp-content">
      <div className="mcp-panel-tabs" role="group" aria-label="能力管理视图">
        <button type="button" aria-pressed={panel === "servers"} onClick={() => setPanel("servers")}>MCP servers</button>
        <button type="button" aria-pressed={panel === "tools"} onClick={() => { setPanel("tools"); void loadTools(); }}>工具与命令</button>
        <button type="button" aria-pressed={panel === "approvals"} onClick={() => { setPanel("approvals"); void loadApproval(); }}>审批策略</button>
      </div>
      {capabilityError ? <Alert type="error" showIcon message="OpenClaw 能力状态读取或写入失败" /> : null}
      {panel === "servers" ? <>
      {runtimeUnavailable ? <Alert type="warning" showIcon message="OpenClaw runtime 未提供 MCP RPC" description="配置可保存在 U 盘，但不会标记为已连接。" /> : null}
      {snapshot?.storage.state === "degraded" ? <Alert type="error" showIcon message="MCP 配置已降级" description={snapshot.storage.message} /> : null}
      {loadError ? <Alert type="error" showIcon message="MCP 配置暂时不可用" description="本地主进程未就绪。" action={<Button size="small" aria-label="重试加载 MCP" onClick={() => void load()}>重试</Button>} /> : null}
      {operationError ? <Alert type="error" showIcon closable message="MCP 操作失败，请重试。" onClose={() => setOperationError(false)} /> : null}
      <div className="mcp-toolbar"><span>{snapshot?.servers.length ?? 0} 个 servers</span><Tooltip title="刷新"><button type="button" aria-label="刷新 MCP servers" disabled={loading} onClick={() => void load()}><RefreshCw /></button></Tooltip></div>
      {loading ? <div className="mcp-state"><RefreshCw className="spin" /><span>正在加载 MCP servers</span></div> : null}
      {!loading && !loadError && snapshot?.servers.length === 0 ? <div className="mcp-state"><CircleOff /><strong>还没有 MCP server</strong><span>新增后可测试连接并查看能力。</span></div> : null}
      <div className="mcp-list" aria-label="MCP server 列表">
        {snapshot?.servers.map((server) => {
          const operation = busy[server.id];
          const actionsUnavailable = runtimeUnavailable || (server.transport === "stdio" && server.risk === "confirmation-required");
          return <article className={`mcp-row${server.enabled ? "" : " disabled"}`} key={server.id}>
            <div className="mcp-icon"><Server /></div>
            <div className="mcp-identity"><div><strong>{server.name}</strong><Tag>{server.transport}</Tag></div><span>{server.id}</span><small>{server.transport === "stdio" ? server.executableId : server.endpointHint}</small></div>
            <div className="mcp-health"><Tag color={statusColors[server.status]}>{statusLabels[server.status]}</Tag><small>{server.lastError?.message ?? "尚未检查"}</small></div>
            <div className="mcp-capabilities"><span>{server.capabilitySummary.tools} 工具</span><span>{server.capabilitySummary.resources} 资源</span><span>{server.capabilitySummary.prompts} prompts</span><small>{[...server.toolNames, ...server.resourceSchemes.map((scheme) => `${scheme}://`)].join(" · ") || "暂无能力摘要"}</small></div>
            <div className="mcp-auth">{server.transport === "stdio" ? <span>风险：{server.risk}</span> : <><span>{server.authentication.type}</span>{server.authentication.type !== "none" && server.authentication.configured ? <code>{server.authentication.hint ?? "configured"}</code> : null}</>}</div>
            <Switch size="small" checked={server.enabled} disabled={Boolean(operation) || (server.transport === "stdio" && server.risk === "confirmation-required")} aria-label={`${server.enabled ? "停用" : "启用"} ${server.name}`} onChange={(enabled) => void mutate(server.id, "toggle", request("mcp.set-enabled", { serverId: server.id, enabled }))} />
            <div className="mcp-actions">
              {operation?.startsWith("mcp-ui-") ? <Tooltip title="取消"><button type="button" aria-label={`取消 ${server.name}`} onClick={() => void invoke?.(request("mcp.cancel", { operationRequestId: operation }))}><X /></button></Tooltip> : null}
              {server.transport === "stdio" && server.risk === "confirmation-required" ? <Button size="small" danger aria-label={`确认 ${server.name} 风险`} onClick={() => setRiskServer(server)}>确认风险</Button> : null}
              <Tooltip title="测试连接"><button type="button" aria-label={`测试 ${server.name}`} disabled={Boolean(operation) || actionsUnavailable} onClick={() => { const operationRequest = request("mcp.test", { serverId: server.id }); void mutate(server.id, operationRequest.requestId, operationRequest); }}><TestTube2 /></button></Tooltip>
              <Tooltip title="重新连接"><button type="button" aria-label={`重连 ${server.name}`} disabled={Boolean(operation) || actionsUnavailable || !server.enabled} onClick={() => { const operationRequest = request("mcp.reconnect", { serverId: server.id }); void mutate(server.id, operationRequest.requestId, operationRequest); }}><RotateCw /></button></Tooltip>
              <Tooltip title="编辑"><button type="button" aria-label={`编辑 ${server.name}`} disabled={Boolean(operation)} onClick={() => openEdit(server)}><Pencil /></button></Tooltip>
              <Popconfirm title="删除 MCP server？" description="配置和 secret 将从 U 盘删除。" okText="删除" cancelText="取消" onConfirm={() => void mutate(server.id, "remove", request("mcp.remove", { serverId: server.id, confirmed: true }))}><Tooltip title="删除"><button type="button" aria-label={`删除 ${server.name}`} disabled={Boolean(operation)}><Trash2 /></button></Tooltip></Popconfirm>
            </div>
          </article>;
        })}
      </div>
      </> : null}
      {panel === "tools" ? <div className="capability-tools-panel">
        <Alert type="info" showIcon message="配置状态与实时 probe 独立展示" description="Catalog 表示可用能力；Effective 表示当前 agent/session 实际权限。" />
        {tools ? <>
          <section><header><h2>Tool catalog</h2><Tag>{tools.agentId}</Tag></header>{tools.catalog.groups.map((group) => <article key={group.id}><strong>{group.label}</strong><span>{group.source}</span><ul>{group.tools.map((tool) => <li key={tool.id}><code>{tool.id}</code><span>{tool.label}</span></li>)}</ul></article>)}</section>
          <section><header><h2>Effective tools</h2><Tag>{tools.effective.profile}</Tag></header>{tools.effective.groups.map((group) => <article key={group.id}><strong>{group.label}</strong><span>{group.source}</span><ul>{group.tools.map((tool) => <li key={tool.id}><code>{tool.id}</code><span>{tool.label}</span>{tool.risk ? <Tag color={tool.risk === "high" ? "error" : "warning"}>{tool.risk}</Tag> : null}</li>)}</ul></article>)}</section>
          <section><header><h2>Commands</h2></header><ul>{tools.commands.map((command) => <li key={command.name}><code>/{command.name}</code><span>{command.description}</span><Tag>{command.scope}</Tag></li>)}</ul></section>
        </> : <div className="mcp-state"><RefreshCw className="spin" /><span>正在读取 OpenClaw 工具投影</span></div>}
      </div> : null}
      {panel === "approvals" ? <div className="approval-policy-panel">
        {approval ? <>
          <Alert type={approval.policy.security === "full" || approval.policy.ask === "off" ? "warning" : "info"} showIcon message="Exec 全局默认策略" description={`security=${approval.policy.security} · ask=${approval.policy.ask} · fallback=${approval.policy.askFallback}。Agent 级覆盖与 allowlist 仍由 OpenClaw 合并决定实际权限。`} />
          <div className="approval-policy-form">
            <label>Security<select aria-label="Exec security" value={approval.policy.security} onChange={(event) => setApproval({ ...approval, policy: { ...approval.policy, security: event.target.value as typeof approval.policy.security } })}><option value="deny">deny</option><option value="allowlist">allowlist</option><option value="full">full</option></select></label>
            <label>Ask<select aria-label="Exec ask" value={approval.policy.ask} onChange={(event) => setApproval({ ...approval, policy: { ...approval.policy, ask: event.target.value as typeof approval.policy.ask } })}><option value="off">off</option><option value="on-miss">on-miss</option><option value="always">always</option></select></label>
            <label>Fallback<select aria-label="Exec fallback" value={approval.policy.askFallback} onChange={(event) => setApproval({ ...approval, policy: { ...approval.policy, askFallback: event.target.value as typeof approval.policy.askFallback } })}><option value="deny">deny</option><option value="allowlist">allowlist</option><option value="full">full</option></select></label>
            <label className="approval-checkbox"><input type="checkbox" checked={approval.policy.autoAllowSkills} onChange={(event) => setApproval({ ...approval, policy: { ...approval.policy, autoAllowSkills: event.target.checked } })} />自动允许 Skill 声明工具</label>
          </div>
          <Button type="primary" aria-label="保存审批策略" onClick={() => void saveApproval()}>保存审批策略</Button>
          {approvalSaved ? <span role="status">策略已从 OpenClaw 读回</span> : null}
        </> : <div className="mcp-state"><RefreshCw className="spin" /><span>正在读取 OpenClaw 审批策略</span></div>}
      </div> : null}
    </div>

    <Modal title={editing ? "编辑 MCP server" : "新增 MCP server"} open={formOpen} onCancel={() => setFormOpen(false)} footer={<><Button onClick={() => setFormOpen(false)}>取消</Button><Button type="primary" onClick={() => void save()}>保存 MCP server</Button></>}>
      <div className="mcp-form">
        {formError ? <Alert type="error" showIcon message={formError} /> : null}
        {editing ? <Alert type="info" showIcon message="安全字段不回显" description="URL、参数、环境变量和 secret 留空时保留原值；stdio 字段可显式清空。" /> : null}
        <label>Transport<select aria-label="Transport" value={form.transport} disabled={Boolean(editing)} onChange={(event) => setForm((current) => ({ ...current, transport: event.target.value as McpTransport }))}><option value="streamable-http">Streamable HTTP</option><option value="http">HTTP</option><option value="stdio">stdio</option></select></label>
        <label>Server ID<Input aria-label="Server ID" value={form.id} disabled={Boolean(editing)} onChange={(event) => setForm((current) => ({ ...current, id: event.target.value }))} /></label>
        <label>显示名称<Input aria-label="显示名称" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
        {form.transport === "stdio" ? <>
          <label>Executable<select aria-label="Executable" value={form.executableId} onChange={(event) => setForm((current) => ({ ...current, executableId: event.target.value as FormState["executableId"] }))}><option value="node">Node.js</option><option value="npx">npx</option><option value="python">Python</option><option value="uvx">uvx</option></select></label>
          <label>参数<Input.TextArea aria-label="参数" rows={3} value={form.args} disabled={form.clearArgs} placeholder="每行一个参数" onChange={(event) => setForm((current) => ({ ...current, args: event.target.value }))} /></label>
          {editing ? <label><input type="checkbox" checked={form.clearArgs} onChange={(event) => setForm((current) => ({ ...current, clearArgs: event.target.checked }))} />清空已有参数</label> : null}
          <label>环境变量<Input.TextArea aria-label="环境变量" rows={3} value={form.env} disabled={form.clearEnv} placeholder="仅 MCP_*，每行 KEY=VALUE" onChange={(event) => setForm((current) => ({ ...current, env: event.target.value }))} /></label>
          {editing ? <label><input type="checkbox" checked={form.clearEnv} onChange={(event) => setForm((current) => ({ ...current, clearEnv: event.target.checked }))} />清空已有环境变量</label> : null}
        </> : <>
          <label>URL<Input aria-label="URL" value={form.url} onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))} /></label>
          <label>认证方式<select aria-label="认证方式" value={form.authenticationType} onChange={(event) => setForm((current) => ({ ...current, authenticationType: event.target.value as FormState["authenticationType"] }))}><option value="none">无</option><option value="bearer">Bearer</option><option value="header">自定义 Header</option></select></label>
          {form.authenticationType === "header" ? <label>Header 名<Input aria-label="Header 名" value={form.headerName} onChange={(event) => setForm((current) => ({ ...current, headerName: event.target.value }))} /></label> : null}
          {form.authenticationType !== "none" ? <label>认证 secret<Input.Password aria-label="认证 secret" autoComplete="new-password" value={form.secret} onChange={(event) => setForm((current) => ({ ...current, secret: event.target.value }))} /></label> : null}
        </>}
      </div>
    </Modal>

    <Modal title="确认 stdio 风险" open={riskServer !== undefined} onCancel={() => { setRiskServer(undefined); setRiskAccepted(false); }} footer={<><Button onClick={() => setRiskServer(undefined)}>取消</Button><Button danger disabled={!riskAccepted} onClick={() => void confirmRisk()}>确认风险</Button></>}>
      <Alert type="warning" showIcon message="该配置会执行受控程序或注入 MCP 环境变量。" />
      <label className="mcp-risk-confirm"><input type="checkbox" checked={riskAccepted} onChange={(event) => setRiskAccepted(event.target.checked)} />我确认执行该受控 stdio 配置</label>
    </Modal>
  </section>;
}
