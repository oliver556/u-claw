import {
  ChannelDraftSchema,
  type ChannelDraft,
  type ChannelIpcRequest,
  type ChannelOperationResult,
  type ChannelSnapshot,
  type ChannelStatus,
  type ManagedChannelSummary,
} from "@uclaw/shared";
import { Alert, Button, Input, Modal, Popconfirm, Select, Switch, Tag, Tooltip } from "antd";
import { Cable, CircleOff, Pencil, Plus, RefreshCw, RotateCw, TestTube2, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { WechatPersonalConnection } from "./WechatPersonalConnection";

type ChannelForm = {
  id: string;
  kind: ChannelDraft["kind"];
  name: string;
  mode: ChannelDraft["mode"];
  enabled: boolean;
  credentials: Record<string, string>;
};

const emptyForm: ChannelForm = { id: "", kind: "telegram", name: "", mode: "bot", enabled: true, credentials: {} };
const kindLabels: Record<ManagedChannelSummary["kind"], string> = {
  telegram: "Telegram",
  "qq-bot": "QQ Bot",
  feishu: "飞书",
  wecom: "企业微信",
  "wechat-personal": "个人微信",
};
const statusLabels: Record<ChannelStatus, string> = {
  "not-configured": "未配置",
  "pending-verification": "待验证",
  connecting: "连接中",
  connected: "已连接",
  disconnected: "已断开",
  "auth-failed": "鉴权失败",
  "rate-limited": "已限流",
  "network-error": "网络错误",
  "needs-action": "需要操作",
};
const statusTones: Record<ChannelStatus, string> = {
  "not-configured": "default",
  "pending-verification": "gold",
  connecting: "processing",
  connected: "success",
  disconnected: "default",
  "auth-failed": "error",
  "rate-limited": "warning",
  "network-error": "error",
  "needs-action": "warning",
};

let requestSequence = 0;
function nextRequestId(): string {
  requestSequence += 1;
  return `channel-ui-${requestSequence}`;
}

function defaultMode(kind: ChannelDraft["kind"]): ChannelDraft["mode"] {
  if (kind === "telegram") return "bot";
  if (kind === "qq-bot") return "app";
  return "websocket";
}

function credentialFields(kind: ChannelDraft["kind"], mode: ChannelDraft["mode"]): Array<{ key: string; label: string; secret: boolean; optional?: boolean }> {
  if (kind === "telegram") return [{ key: "botToken", label: "Bot Token", secret: true }];
  if (kind === "qq-bot") return [{ key: "appId", label: "App ID", secret: false }, { key: "clientSecret", label: "Client Secret", secret: true }];
  if (kind === "feishu") return [
    { key: "appId", label: "App ID", secret: false },
    { key: "appSecret", label: "App Secret", secret: true },
    ...(mode === "webhook" ? [{ key: "verificationToken", label: "Verification Token", secret: true }, { key: "encryptKey", label: "Encrypt Key", secret: true }] : []),
  ];
  return mode === "webhook"
    ? [{ key: "token", label: "Token", secret: true }, { key: "encodingAESKey", label: "Encoding AES Key", secret: true }, { key: "receiveId", label: "Receive ID", secret: false, optional: true }]
    : [{ key: "botId", label: "Bot ID", secret: false }, { key: "secret", label: "Secret", secret: true }];
}

function draftFromForm(form: ChannelForm): unknown {
  const fields = credentialFields(form.kind, form.mode);
  const credentials = Object.fromEntries(fields
    .filter(({ key, optional }) => !optional || Boolean(form.credentials[key]?.trim()))
    .map(({ key }) => [key, form.credentials[key]?.trim() ?? ""]));
  return { id: form.id, kind: form.kind, name: form.name, mode: form.mode, enabled: form.enabled, credentials };
}

function formatCheckedAt(value: string | undefined): string {
  if (!value) return "尚未检查";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

export function ChannelSettings() {
  const [snapshot, setSnapshot] = useState<ChannelSnapshot>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [operationError, setOperationError] = useState<string>();
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedChannelSummary>();
  const [form, setForm] = useState<ChannelForm>(emptyForm);
  const [formError, setFormError] = useState<string>();

  const invoke = window.uclaw?.channels?.invoke;
  const request = (method: ChannelIpcRequest["method"], params: Record<string, unknown>) => ({ method, requestId: nextRequestId(), params }) as ChannelIpcRequest;
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    if (!invoke) {
      setLoadError(true);
      setLoading(false);
      return;
    }
    try {
      const response = await invoke({ method: "channels.list-managed", requestId: nextRequestId(), params: {} });
      if (!response.ok || response.method !== "channels.list-managed") throw new Error();
      setSnapshot(response.result);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [invoke]);

  useEffect(() => { void load(); }, [load]);

  const mutate = async (channelId: string, operation: string, channelRequest: ChannelIpcRequest) => {
    if (!invoke || busy[channelId]) return false;
    setBusy((current) => ({ ...current, [channelId]: operation }));
    setOperationError(undefined);
    try {
      const response = await invoke(channelRequest);
      if (!response.ok) throw new Error();
      if (response.method === "channels.test" || response.method === "channels.reconnect") {
        const result = response.result as ChannelOperationResult;
        setSnapshot((current) => current ? {
          ...current,
          channels: current.channels.map((channel) => channel.id === result.channelId ? {
            ...channel,
            status: result.status,
            lastCheckedAt: result.checkedAt,
            ...(result.error ? { error: result.error } : { error: undefined }),
          } : channel),
        } : current);
      } else {
        setSnapshot(response.result as ChannelSnapshot);
      }
      return true;
    } catch {
      setOperationError("渠道操作失败，请检查连接后重试。");
      return false;
    } finally {
      setBusy((current) => { const next = { ...current }; delete next[channelId]; return next; });
    }
  };

  const cancel = async (channelId: string) => {
    if (!invoke || !busy[channelId]) return;
    const operationRequestId = busy[channelId];
    await invoke(request("channels.cancel", { operationRequestId })).catch(() => undefined);
  };

  const openCreate = () => {
    setEditing(undefined);
    setForm(emptyForm);
    setFormError(undefined);
    setFormOpen(true);
  };
  const openEdit = (channel: ManagedChannelSummary) => {
    if (channel.kind === "wechat-personal" || channel.mode === "qr") return;
    setEditing(channel);
    setForm({ id: channel.id, kind: channel.kind, name: channel.name, mode: channel.mode as ChannelDraft["mode"], enabled: channel.enabled, credentials: {} });
    setFormError(undefined);
    setFormOpen(true);
  };
  const save = async () => {
    const parsed = ChannelDraftSchema.safeParse(draftFromForm(form));
    if (!parsed.success) {
      setFormError("请填写有效连接名称、渠道 ID 和全部凭据。");
      return;
    }
    const method = editing ? "channels.update" : "channels.create";
    const channelRequest = request(method, editing ? { channelId: editing.id, channel: parsed.data } : { channel: parsed.data });
    if (await mutate(editing?.id ?? parsed.data.id, channelRequest.requestId, channelRequest)) setFormOpen(false);
    else setFormError("渠道保存失败，请重试。");
  };

  const filtered = useMemo(() => snapshot?.channels.filter((channel) =>
    (kindFilter === "all" || channel.kind === kindFilter) && (statusFilter === "all" || channel.status === statusFilter),
  ) ?? [], [kindFilter, snapshot, statusFilter]);

  return <section className="secondary-view channel-settings">
    <header className="channel-page-header"><div><h1>渠道连接</h1><p>OpenClaw 消息渠道配置与运行状态</p></div><Button type="primary" icon={<Plus />} onClick={openCreate}>新增连接</Button></header>
    <div className="secondary-content channel-content">
      {loadError ? <Alert type="error" showIcon message="渠道配置暂时不可用" description="当前离线或本地服务未就绪。" action={<Button size="small" aria-label="重试加载渠道" onClick={() => void load()}>重试</Button>} /> : null}
      {operationError ? <Alert type="error" showIcon closable message={operationError} onClose={() => setOperationError(undefined)} /> : null}
      <WechatPersonalConnection />
      <div className="channel-toolbar" aria-label="渠道筛选器">
        <label>渠道<Select aria-label="渠道筛选" value={kindFilter} onChange={setKindFilter} options={[{ value: "all", label: "全部渠道" }, ...Object.entries(kindLabels).map(([value, label]) => ({ value, label }))]} /></label>
        <label>状态<Select aria-label="状态筛选" value={statusFilter} onChange={setStatusFilter} options={[{ value: "all", label: "全部状态" }, ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))]} /></label>
        <Button icon={<RefreshCw />} aria-label="刷新渠道" onClick={() => void load()} disabled={loading}>刷新</Button>
      </div>
      {loading ? <div className="channel-state"><RefreshCw className="spin" /><span>正在加载渠道</span></div> : null}
      {!loading && !loadError && snapshot?.channels.length === 0 ? <div className="channel-state"><CircleOff /><strong>还没有渠道配置</strong><span>新增连接后可测试并启用渠道。</span></div> : null}
      {!loading && !loadError && snapshot && snapshot.channels.length > 0 && filtered.length === 0 ? <div className="channel-state"><CircleOff /><strong>没有符合筛选条件的渠道</strong></div> : null}
      <div className="channel-list" aria-label="渠道列表">
        {filtered.map((channel) => {
          const unavailable = channel.capability === "unavailable";
          const operation = busy[channel.id];
          return <article className={`channel-row${channel.enabled ? "" : " disabled"}`} key={channel.id}>
            <div className="channel-icon"><Cable /></div>
            <div className="channel-identity">
              <div><strong>{channel.name}</strong><Tag>{kindLabels[channel.kind]}</Tag><Tag>{channel.mode}</Tag></div>
              <span>{channel.id}</span>
              <small>最后检查：{formatCheckedAt(channel.lastCheckedAt)}</small>
            </div>
            <div className="channel-health"><Tag color={statusTones[channel.status]}>{statusLabels[channel.status]}</Tag><small>{channel.error?.message ?? (channel.enabled ? "运行已启用" : "运行已停用")}</small></div>
            <div className="channel-secrets" aria-label={`${channel.name} 凭据提示`}>
              {Object.entries(channel.credentialHints).map(([key, value]) => <span key={key}><small>{key}</small><code>{value}</code></span>)}
            </div>
            <Switch size="small" checked={channel.enabled} disabled={Boolean(operation) || unavailable} aria-label={`${channel.enabled ? "停用" : "启用"} ${channel.name}`} onChange={(enabled) => void mutate(channel.id, "toggle", request("channels.set-enabled", { channelId: channel.id, enabled }))} />
            <div className="channel-actions">
              {operation?.startsWith("channel-ui-") ? <Tooltip title="取消"><button type="button" aria-label={`取消 ${channel.name}`} onClick={() => void cancel(channel.id)}><X /></button></Tooltip> : null}
              <Tooltip title="测试连接"><button type="button" aria-label={`测试 ${channel.name}`} disabled={Boolean(operation) || unavailable} onClick={() => { const testRequest = request("channels.test", { channelId: channel.id }); void mutate(channel.id, testRequest.requestId, testRequest); }}><TestTube2 /></button></Tooltip>
              <Tooltip title="重新连接"><button type="button" aria-label={`重连 ${channel.name}`} disabled={Boolean(operation) || unavailable || !channel.enabled} onClick={() => { const reconnectRequest = request("channels.reconnect", { channelId: channel.id }); void mutate(channel.id, reconnectRequest.requestId, reconnectRequest); }}><RotateCw /></button></Tooltip>
              <Tooltip title="编辑凭据"><button type="button" aria-label={`编辑 ${channel.name}`} disabled={Boolean(operation)} onClick={() => openEdit(channel)}><Pencil /></button></Tooltip>
              <Popconfirm title="删除渠道连接？" description="配置和已存凭据将从 U 盘删除。" okText="删除" cancelText="取消" onConfirm={() => void mutate(channel.id, "remove", request("channels.remove", { channelId: channel.id }))}><Tooltip title="删除"><button type="button" aria-label={`删除 ${channel.name}`} disabled={Boolean(operation)}><Trash2 /></button></Tooltip></Popconfirm>
            </div>
            {unavailable ? <Alert className="channel-capability" type="warning" showIcon message="Capability unavailable" description={channel.capabilityReason ?? "当前运行时不支持此渠道。"} /> : null}
          </article>;
        })}
      </div>
    </div>

    <Modal title={editing ? "编辑渠道连接" : "新增渠道连接"} open={formOpen} onCancel={() => setFormOpen(false)} footer={<><Button onClick={() => setFormOpen(false)}>取消</Button><Button type="primary" onClick={() => void save()}>保存渠道</Button></>}>
      <div className="channel-form">
        {formError ? <Alert type="error" showIcon message={formError} /> : null}
        <label>渠道<select aria-label="渠道" value={form.kind} disabled={Boolean(editing)} onChange={(event) => { const kind = event.target.value as ChannelDraft["kind"]; setForm((current) => ({ ...current, kind, mode: defaultMode(kind), credentials: {} })); }}><option value="telegram">Telegram</option><option value="qq-bot">QQ Bot（非个人 QQ）</option><option value="feishu">飞书</option><option value="wecom">企业微信</option></select></label>
        {(form.kind === "feishu" || form.kind === "wecom") ? <label>连接模式<select aria-label="连接模式" value={form.mode} onChange={(event) => setForm((current) => ({ ...current, mode: event.target.value as ChannelDraft["mode"], credentials: {} }))}><option value="websocket">App / WebSocket</option><option value="webhook">Webhook</option></select></label> : null}
        <label>渠道 ID<Input aria-label="渠道 ID" value={form.id} disabled={Boolean(editing)} onChange={(event) => setForm((current) => ({ ...current, id: event.target.value }))} /></label>
        <label>连接名称<Input aria-label="连接名称" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
        {editing ? <Alert type="info" showIcon message="已存凭据不会回显" description="输入全部新凭据后将替换 U 盘中的旧凭据。" /> : null}
        {credentialFields(form.kind, form.mode).map((field) => <label key={field.key}>{field.label}{field.secret
          ? <Input.Password aria-label={field.label} autoComplete="new-password" value={form.credentials[field.key] ?? ""} onChange={(event) => setForm((current) => ({ ...current, credentials: { ...current.credentials, [field.key]: event.target.value } }))} />
          : <Input aria-label={field.label} value={form.credentials[field.key] ?? ""} onChange={(event) => setForm((current) => ({ ...current, credentials: { ...current.credentials, [field.key]: event.target.value } }))} />}{editing && channelHint(editing, field.key) ? <small>已保存：{channelHint(editing, field.key)}</small> : null}</label>)}
      </div>
    </Modal>
  </section>;
}

function channelHint(channel: ManagedChannelSummary, key: string): string | undefined {
  return channel.credentialHints[key];
}
