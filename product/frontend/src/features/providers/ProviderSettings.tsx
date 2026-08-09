import {
  BUILT_IN_PROVIDER_TEMPLATES,
  ProviderDraftSchema,
  type ProviderConfigSummary,
  type ProviderDraft,
  type ProviderIpcRequest,
  type ProviderSnapshot,
} from "@uclaw/shared";
import { Alert, Button, Input, Modal, Popconfirm, Switch, Tag, Tooltip } from "antd";
import { ArrowDown, ArrowUp, Check, KeyRound, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type ProviderForm = {
  id: string;
  templateId: ProviderDraft["templateId"] | "custom";
  name: string;
  enabled: boolean;
  baseUrl: string;
  model: string;
};

let providerRequestSequence = 0;
const emptyForm: ProviderForm = { id: "", templateId: "custom", name: "", enabled: true, baseUrl: "", model: "" };

function nextRequestId() {
  providerRequestSequence += 1;
  return `provider-${providerRequestSequence}`;
}

function formFor(provider: ProviderConfigSummary): ProviderForm {
  return {
    id: provider.id,
    templateId: provider.templateId ?? "custom",
    name: provider.name,
    enabled: provider.enabled,
    baseUrl: provider.baseUrl ?? "",
    model: provider.model,
  };
}

export function ProviderSettings() {
  const [snapshot, setSnapshot] = useState<ProviderSnapshot>();
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [form, setForm] = useState<ProviderForm>(emptyForm);
  const [formError, setFormError] = useState<string>();
  const [keyProvider, setKeyProvider] = useState<ProviderConfigSummary>();
  const [newApiKey, setNewApiKey] = useState("");
  const [keyError, setKeyError] = useState<string>();

  const invoke = window.uclaw?.providers?.invoke;
  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    if (!invoke) {
      setError("Provider 配置加载失败，请重试");
      setLoading(false);
      return;
    }
    try {
      const response = await invoke({ method: "providers.list", requestId: nextRequestId(), params: {} });
      if (!response.ok) throw new Error();
      setSnapshot(response.result as ProviderSnapshot);
    } catch {
      setError("Provider 配置加载失败，请重试");
    } finally {
      setLoading(false);
    }
  }, [invoke]);

  useEffect(() => { void load(); }, [load]);

  const mutate = async (request: ProviderIpcRequest, providerId: string): Promise<boolean> => {
    if (!invoke || busyId) return false;
    setBusyId(providerId);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await invoke(request);
      if (!response.ok) throw new Error();
      if (request.method !== "providers.verify") setSnapshot(response.result as ProviderSnapshot);
      return true;
    } catch {
      setError("Provider 配置保存失败，请重试");
      return false;
    } finally {
      setBusyId(undefined);
    }
  };

  const request = (method: ProviderIpcRequest["method"], params: Record<string, unknown>) => ({
    method,
    requestId: nextRequestId(),
    params,
  }) as ProviderIpcRequest;

  const openCreate = () => {
    setEditingId(undefined);
    setForm(emptyForm);
    setFormError(undefined);
    setFormOpen(true);
  };
  const openEdit = (provider: ProviderConfigSummary) => {
    setEditingId(provider.id);
    setForm(formFor(provider));
    setFormError(undefined);
    setFormOpen(true);
  };
  const selectTemplate = (value: string) => {
    if (value === "custom") {
      setForm((current) => ({ ...current, templateId: "custom" }));
      return;
    }
    const template = BUILT_IN_PROVIDER_TEMPLATES.find(({ id }) => id === value);
    if (!template) return;
    setForm((current) => ({
      ...current,
      templateId: template.id,
      id: current.id || template.id,
      name: template.name,
      baseUrl: template.baseUrl ?? "",
      model: template.model,
    }));
  };
  const saveProvider = async () => {
    const draft = ProviderDraftSchema.safeParse({
      id: form.id,
      ...(form.templateId === "custom" ? {} : { templateId: form.templateId }),
      name: form.name,
      enabled: form.enabled,
      baseUrl: form.baseUrl.trim() || null,
      model: form.model,
    });
    if (!draft.success) {
      setFormError("Base URL、Provider ID 或模型名无效");
      return;
    }
    const method = editingId ? "providers.update" : "providers.create";
    if (await mutate(request(method, editingId ? { providerId: editingId, provider: draft.data } : { provider: draft.data }), editingId ?? draft.data.id)) {
      setFormOpen(false);
    } else {
      setFormError("Provider 保存失败，请重试");
    }
  };
  const saveKey = async () => {
    if (!keyProvider || !newApiKey) return;
    if (await mutate(request("providers.set-api-key", { providerId: keyProvider.id, apiKey: newApiKey }), keyProvider.id)) {
      setNewApiKey("");
      setKeyProvider(undefined);
    } else {
      setKeyError("API Key 保存失败，请重试");
    }
  };
  const verify = async (provider: ProviderConfigSummary) => {
    if (!invoke || busyId) return;
    setBusyId(provider.id);
    setError(undefined);
    try {
      await invoke(request("providers.verify", { providerId: provider.id }));
    } catch {
      // Verification contract is deliberately deferred to MODEL-005.
    } finally {
      setBusyId(undefined);
      setNotice("真实连通验证将在 MODEL-005 提供");
    }
  };

  return <section className="secondary-view provider-settings">
    <header className="provider-page-header"><div><h1>模型 Provider</h1><p>Provider 配置</p></div><Button type="primary" icon={<Plus />} onClick={openCreate}>新增 Provider</Button></header>
    <div className="secondary-content provider-content">
      {error ? <Alert type="error" showIcon message={error} action={error.startsWith("Provider 配置加载") ? <Button size="small" aria-label="重试" onClick={() => void load()}>重试</Button> : undefined} /> : null}
      {notice ? <Alert type="info" showIcon closable message={notice} onClose={() => setNotice(undefined)} /> : null}
      {loading ? <div className="provider-state"><RefreshCw className="spin" /><span>正在加载 Provider</span></div> : null}
      {!loading && snapshot?.providers.length === 0 ? <div className="provider-state"><strong>暂无 Provider</strong></div> : null}
      <div className="provider-list" aria-label="Provider 列表">
        {snapshot?.providers.map((provider, index) => {
          const selected = snapshot.selectedProviderId === provider.id;
          const rowBusy = busyId === provider.id;
          const locked = busyId !== undefined;
          return <article className={`provider-row${selected ? " selected" : ""}${provider.enabled ? "" : " disabled"}`} key={provider.id}>
            <Tooltip title={selected ? "当前 Provider" : "设为当前 Provider"}><button className="provider-select" type="button" aria-label={`选择 ${provider.name}`} disabled={selected || !provider.enabled || locked} onClick={() => void mutate(request("providers.select", { providerId: provider.id }), provider.id)}><Check aria-hidden="true" /></button></Tooltip>
            <div className="provider-identity"><div><strong>{provider.name}</strong>{selected ? <Tag color="blue">当前</Tag> : null}{provider.templateId ? <Tag>内置</Tag> : <Tag color="cyan">自定义</Tag>}</div><span>{provider.model}</span><small>{provider.baseUrl ?? "OpenClaw 原生 Provider"}</small></div>
            <div className="provider-key-state"><KeyRound aria-hidden="true" /><span>{provider.apiKeyConfigured ? provider.apiKeyHint : "未配置"}</span></div>
            <Switch size="small" aria-label={`启用 ${provider.name}`} checked={provider.enabled} disabled={locked} loading={rowBusy} onChange={(enabled) => void mutate(request("providers.set-enabled", { providerId: provider.id, enabled }), provider.id)} />
            <div className="provider-actions">
              <Tooltip title="上移"><button type="button" aria-label={`上移 ${provider.name}`} disabled={index === 0 || locked} onClick={() => void mutate(request("providers.move", { providerId: provider.id, direction: "up" }), provider.id)}><ArrowUp /></button></Tooltip>
              <Tooltip title="下移"><button type="button" aria-label={`下移 ${provider.name}`} disabled={index === (snapshot?.providers.length ?? 0) - 1 || locked} onClick={() => void mutate(request("providers.move", { providerId: provider.id, direction: "down" }), provider.id)}><ArrowDown /></button></Tooltip>
              <Tooltip title="验证"><button type="button" aria-label={`验证 ${provider.name}`} disabled={locked} onClick={() => void verify(provider)}><ShieldCheck /></button></Tooltip>
              <Tooltip title="API Key"><button type="button" aria-label={`管理 ${provider.name} API Key`} disabled={locked} onClick={() => { setNewApiKey(""); setKeyError(undefined); setKeyProvider(provider); }}><KeyRound /></button></Tooltip>
              <Tooltip title="编辑"><button type="button" aria-label={`编辑 ${provider.name}`} disabled={locked} onClick={() => openEdit(provider)}><Pencil /></button></Tooltip>
              <Popconfirm title="删除 Provider？" okText="删除" cancelText="取消" onConfirm={() => void mutate(request("providers.remove", { providerId: provider.id }), provider.id)}><Tooltip title="删除"><button type="button" aria-label={`删除 ${provider.name}`} disabled={locked}><Trash2 /></button></Tooltip></Popconfirm>
            </div>
          </article>;
        })}
      </div>
    </div>

    <Modal title={editingId ? "编辑 Provider" : "新增 Provider"} open={formOpen} onCancel={() => setFormOpen(false)} footer={<><Button onClick={() => setFormOpen(false)}>取消</Button><Button type="primary" onClick={() => void saveProvider()}>保存 Provider</Button></>}>
      <div className="provider-form">
        {formError ? <Alert type="error" showIcon message={formError} /> : null}
        <label>类型<select aria-label="Provider 类型" value={form.templateId} onChange={(event) => selectTemplate(event.target.value)}><option value="custom">OpenAI-compatible 自定义</option>{BUILT_IN_PROVIDER_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
        <label>Provider ID<Input aria-label="Provider ID" value={form.id} disabled={editingId !== undefined} onChange={(event) => setForm((current) => ({ ...current, id: event.target.value }))} /></label>
        <label>显示名称<Input aria-label="显示名称" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
        <label>Base URL<Input aria-label="Base URL" value={form.baseUrl} onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))} /></label>
        <label>模型名<Input aria-label="模型名" value={form.model} onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))} /></label>
      </div>
    </Modal>

    <Modal title={keyProvider ? `${keyProvider.name} API Key` : "API Key"} open={keyProvider !== undefined} onCancel={() => { setNewApiKey(""); setKeyError(undefined); setKeyProvider(undefined); }} footer={<><Button onClick={() => { setNewApiKey(""); setKeyError(undefined); setKeyProvider(undefined); }}>取消</Button>{keyProvider?.apiKeyConfigured ? <Popconfirm title="清除已存 Key？" okText="清除" cancelText="取消" onConfirm={() => { if (keyProvider) void mutate(request("providers.clear-api-key", { providerId: keyProvider.id }), keyProvider.id).then((saved) => { if (saved) setKeyProvider(undefined); else setKeyError("API Key 清除失败，请重试"); }); }}><Button danger>清除 Key</Button></Popconfirm> : null}<Button type="primary" disabled={!newApiKey} onClick={() => void saveKey()}>保存 Key</Button></>}>
      {keyError ? <Alert type="error" showIcon message={keyError} className="provider-key-error" /> : null}
      <Input.Password aria-label="新 API Key" autoComplete="new-password" value={newApiKey} onChange={(event) => setNewApiKey(event.target.value)} />
    </Modal>
  </section>;
}
