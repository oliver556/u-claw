import type { LocalSkillDetail, SkillCatalogItem, SkillDetail, SkillIpcRequest, SkillOperation, SkillRuntimeItem } from "@uclaw/shared";
import { Alert, Button, Input, Select, Switch } from "antd";
import { AlertTriangle, Box, CircleCheck, Download, ExternalLink, Layers3, MoreHorizontal, PackageOpen, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SafeMarkdown } from "../chat/MessageContent";
import { SkillLogo } from "./SkillLogo";

let sequence = 0;
const availabilityLabel = { available: "可用", disabled: "已禁用", "missing-dependency": "缺少依赖", conflict: "存在冲突", "not-detected": "OpenClaw 未识别", error: "读取失败" } as const;
const sourceLabel = (item: SkillCatalogItem) => item.source.provider === "portable" ? "随包内置" : item.source.provider === "openclaw" ? "本地工作区" : "用户导入";
const sourceDetail = (item: SkillCatalogItem) => item.source.provider === "portable" ? "U-Claw" : item.source.provider === "skillhub" ? "Skill Manager" : "本地 ZIP";
const availabilityDetail = (item: SkillRuntimeItem | undefined) => {
  if (!item) return "OpenClaw 未读到";
  if (item.availability === "missing-dependency") return `${item.missing.bins[0] ?? item.missing.env[0] ?? "运行依赖"} 未找到`;
  if (item.availability === "available") return "OpenClaw 已读取";
  if (item.availability === "disabled") return "不会向会话提供能力";
  return "需要检查运行配置";
};

export function skillMarkdownBody(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return normalized;
  const frontmatter = normalized.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return frontmatter ? normalized.slice(frontmatter[0].length).trimStart() : normalized;
}

/** 呈现已安装 Skill、运行状态与本地导入操作，并统一使用 Ant 控件。 */
export function InstalledSkillWorkbench() {
  const invoke = window.uclaw?.skills?.invoke;
  const importPendingRef = useRef(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [importState, setImportState] = useState<"idle" | "selecting" | "validating" | "installing">("idle");
  const [items, setItems] = useState<SkillCatalogItem[]>([]);
  const [runtime, setRuntime] = useState<SkillRuntimeItem[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [source, setSource] = useState("all");
  const [selected, setSelected] = useState<SkillCatalogItem>();
  const [selectedDetail, setSelectedDetail] = useState<LocalSkillDetail>();
  const [detailState, setDetailState] = useState<"idle" | "loading" | "error">("idle");
  const [detailError, setDetailError] = useState("");
  const [togglingSlug, setTogglingSlug] = useState("");
  const [importCandidate, setImportCandidate] = useState<{ token: string; detail: SkillDetail }>();
  const [confirmed, setConfirmed] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error"; message: string }>();

  const call = useCallback(async <T,>(method: SkillIpcRequest["method"], params: Record<string, unknown>): Promise<T> => {
    if (!invoke) throw new Error("Skill 服务不可用");
    const response = await invoke({ method, requestId: `skill-workbench-${++sequence}`, params } as SkillIpcRequest) as any;
    if (!response.ok) throw new Error(response.error.message);
    return response.result as T;
  }, [invoke]);

  const load = useCallback(async () => {
    setState("loading"); setError("");
    try {
      const [installed, inventory] = await Promise.all([
        call<SkillCatalogItem[]>("skills.installed", {}),
        call<{ skills: SkillRuntimeItem[] }>("skills.runtime-status", {}),
      ]);
      setItems(installed); setRuntime(inventory.skills); setState("ready");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Skill 数据读取失败"); setState("error");
    }
  }, [call]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!selected) { setSelectedDetail(undefined); setDetailState("idle"); setDetailError(""); return; }
    let active = true;
    setSelectedDetail(undefined); setDetailState("loading"); setDetailError("");
    void call<LocalSkillDetail>("skills.local-detail", { slug: selected.slug }).then((detail) => {
      if (active) { setSelectedDetail(detail); setDetailState("idle"); }
    }).catch((caught) => {
      if (active) {
        setDetailError(caught instanceof Error ? caught.message : "SKILL.md 读取失败");
        setDetailState("error");
      }
    });
    return () => { active = false; };
  }, [call, selected]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(undefined), 4_000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const runtimeFor = (slug: string) => runtime.find((item) => item.id === slug && !item.bundled) ?? runtime.find((item) => item.id === slug);
  const filtered = useMemo(() => items.filter((item) => {
    const actual = runtimeFor(item.slug);
    const matchesQuery = `${item.name} ${item.slug} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase());
    return matchesQuery && (status === "all" || actual?.availability === status) && (source === "all" || item.source.provider === source);
  }), [items, query, runtime, source, status]);
  const needsAttention = items.filter((item) => !["available", "disabled"].includes(runtimeFor(item.slug)?.availability ?? "not-detected")).length;

  const openHub = async () => { try { setActionError(""); await call("skills.open-hub", {}); } catch (caught) { setActionError(caught instanceof Error ? caught.message : "无法打开 SkillHub"); } };
  const beginImport = async () => {
    setActionError("");
    setImportState("selecting");
    try {
      const selectedFile = await call<{ token: string } | null>("skills.import-select", {});
      if (!selectedFile) return;
      setImportState("validating");
      const detail = await call<SkillDetail>("skills.import-prepare", { token: selectedFile.token });
      setImportCandidate({ token: selectedFile.token, detail }); setConfirmed(false);
    } catch (caught) { setActionError(caught instanceof Error ? caught.message : "Skill ZIP 校验失败"); }
    finally { setImportState("idle"); }
  };
  /** Starts one ZIP installation and exposes loading before Desktop returns an operation. */
  const installImport = async () => {
    if (!importCandidate || !confirmed || importPendingRef.current) return;
    importPendingRef.current = true;
    setActionError("");
    setImportState("installing");
    try {
      let operation = await call<SkillOperation>("skills.import-install", { token: importCandidate.token, confirmation: { permissionFingerprint: importCandidate.detail.permissionFingerprint, acceptedRisk: importCandidate.detail.risk } });
      setImportCandidate(undefined);
      while (operation.state === "queued" || operation.state === "running") {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        operation = await call<SkillOperation>("skills.operation", { operationId: operation.id });
      }
      if (operation.state !== "succeeded") throw new Error(operation.error ?? `安装在 ${operation.phase} 阶段失败`);
      setToast({ kind: "success", message: `${importCandidate.detail.name} 安装成功，OpenClaw 已完成读回` });
      await load();
    } catch (caught) { setActionError(caught instanceof Error ? caught.message : "Skill 安装失败"); }
    finally {
      importPendingRef.current = false;
      setImportState("idle");
    }
  };
  const cancelImport = async () => {
    const candidate = importCandidate;
    setImportCandidate(undefined);
    if (candidate) await call("skills.import-dispose", { token: candidate.token }).catch(() => undefined);
  };
  const toggle = async (item: SkillCatalogItem) => {
    setActionError("");
    setTogglingSlug(item.slug);
    const nextEnabled = !item.enabled;
    try {
      const operation = await call<SkillOperation>("skills.set-enabled", { slug: item.slug, enabled: nextEnabled, confirmation: null });
      if (operation.state !== "succeeded") throw new Error(operation.error ?? "OpenClaw 未确认 Skill 启用状态");
      await load();
      setToast({ kind: "success", message: `${item.name}已${nextEnabled ? "启用" : "停用"}` });
    } catch (caught) {
      setToast({ kind: "error", message: caught instanceof Error ? caught.message : "启用状态修改失败" });
    }
    finally { setTogglingSlug(""); }
  };

  return <section className="skill-workbench" aria-label="本地 Skill 工作台">
    <header className="skill-workbench-head"><div><h1>Skill</h1><p>管理 U 盘中已安装的能力与 OpenClaw 运行状态</p></div><div className="skill-workbench-actions"><Button aria-label="导入 Skill" loading={importState === "selecting" || importState === "validating"} disabled={importState !== "idle"} icon={<PackageOpen />} onClick={() => void beginImport()}>{importState === "selecting" ? "选择中" : importState === "validating" ? "校验中" : "导入 Skill"}</Button><Button type="primary" aria-label="发现更多 Skill" icon={<ExternalLink />} onClick={() => void openHub()}>发现更多</Button></div></header>
    <div className="skill-workbench-main">
    <div className="skill-stats" aria-label="Skill 统计"><div><i><Layers3 /></i><span>已安装<strong>{items.length}<small> Skills</small></strong></span></div><div><i><CircleCheck /></i><span>可正常使用<strong>{items.filter((item) => runtimeFor(item.slug)?.availability === "available").length}</strong></span></div><div><i><AlertTriangle /></i><span>需要处理<strong>{needsAttention}</strong></span></div><div><i><Download /></i><span>可更新<strong>{items.filter((item) => item.updateAvailable).length}</strong></span></div></div>
    <div className="skill-workbench-toolbar"><Input className="skill-workbench-search" aria-label="搜索本地 Skill" placeholder="搜索名称、说明或来源" value={query} prefix={<Search aria-hidden="true" />} allowClear onChange={(event) => setQuery(event.target.value)} /><Select className="skill-workbench-select" aria-label="按状态筛选" value={status} virtual={false} onChange={setStatus} options={[{ value: "all", label: "状态：全部" }, ...Object.entries(availabilityLabel).map(([value, label]) => ({ value, label }))]} /><Select className="skill-workbench-select" aria-label="按来源筛选" value={source} virtual={false} onChange={setSource} options={[{ value: "all", label: "来源：全部" }, { value: "openclaw", label: "本地工作区" }, { value: "portable", label: "随包内置" }, { value: "skillhub", label: "用户导入" }]} /><span className="skill-result-count">{filtered.length} 个 Skill</span><Button title="刷新" aria-label="刷新本地 Skill" icon={<RefreshCw />} onClick={() => void load()} /></div>
    {state === "loading" ? <div className="skill-workbench-loading" aria-label="正在读取本地 Skill">{[0, 1, 2].map((value) => <span key={value} />)}</div> : null}
    {state === "error" ? <Alert className="skill-workbench-alert" type="error" showIcon role="alert" message="本地 Skill 读取失败" description={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} /> : null}
    {actionError ? <Alert className="skill-workbench-alert" type="error" showIcon role="alert" message="Skill 操作失败" description={actionError} closable onClose={() => setActionError("")} /> : null}
    {toast ? <div className={`skill-toast ${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>{toast.kind === "error" ? <AlertTriangle /> : <CircleCheck />}<span>{toast.message}</span><button type="button" aria-label="关闭操作提示" title="关闭" onClick={() => setToast(undefined)}><X /></button></div> : null}
    {state === "ready" && items.length === 0 ? <div className="skill-workbench-empty"><Box /><strong>尚未安装 Skill</strong><span>从 SkillHub 发现能力，或导入已下载的 ZIP 安装包。</span></div> : null}
    {state === "ready" && items.length > 0 && filtered.length === 0 ? <div className="skill-workbench-empty"><Search /><strong>没有符合条件的 Skill</strong><Button type="link" aria-label="清除筛选" onClick={() => { setQuery(""); setStatus("all"); setSource("all"); }}>清除筛选</Button></div> : null}
    {state === "ready" && filtered.length > 0 ? <div className="skill-table" role="table" aria-label="本地 Skill 列表"><div className="skill-table-head" role="row"><span>Skill</span><span>来源</span><span>版本</span><span>OpenClaw 状态</span><span>启用</span><span>操作</span></div>{filtered.map((item) => { const actual = runtimeFor(item.slug); const availability = actual?.availability ?? "not-detected"; const switchDisabled = togglingSlug === item.slug || !actual || actual.availability === "not-detected" || actual.availability === "conflict"; return <div className="skill-table-row" role="row" key={item.slug}><button type="button" className="skill-table-identity" aria-label={`打开 ${item.name}详情`} onClick={() => setSelected(item)}><SkillLogo name={item.name} logoUrl={item.logoUrl} /><div><strong>{item.name}{item.updateAvailable ? <small>可更新</small> : item.source.provider === "portable" ? <small>内置</small> : availability === "disabled" ? <small>已禁用</small> : null}</strong><span>{item.description}</span></div></button><span className="skill-table-meta">{sourceLabel(item)}<small>{sourceDetail(item)}</small></span><code>{item.installedVersion ?? item.version}</code><span className={`skill-status ${availability}`}>{availabilityLabel[availability]}<small>{availabilityDetail(actual)}</small></span><Switch size="small" aria-label={`${item.enabled ? "禁用" : "启用"} ${item.name}`} checked={item.enabled} loading={togglingSlug === item.slug} disabled={switchDisabled} onChange={() => void toggle(item)} /><Button type="text" title="查看详情" aria-label={`查看 ${item.name}`} icon={<MoreHorizontal />} onClick={() => setSelected(item)} /></div>; })}</div> : null}
    <div className="skill-security-note"><AlertTriangle /><span>ZIP 在本机校验并安装，不上传服务器。网络来源 Skill 统一按高风险确认。</span></div>
    {selected ? <div className="skill-drawer-backdrop" onMouseDown={() => setSelected(undefined)}><aside className="skill-drawer" role="dialog" aria-modal="true" aria-label={`Skill 详情 ${selected.name}`} onMouseDown={(event) => event.stopPropagation()}><header><div><span>SKILL DETAIL</span><h3>{selected.name}</h3><code>{selected.slug} · v{selected.version}</code></div><button aria-label="关闭 Skill 详情" onClick={() => setSelected(undefined)}><X /></button></header><div className="skill-drawer-body"><dl><dt>来源</dt><dd>{sourceLabel(selected)}</dd><dt>OpenClaw</dt><dd>{availabilityLabel[runtimeFor(selected.slug)?.availability ?? "not-detected"]}</dd><dt>权限风险</dt><dd>{selected.risk}</dd></dl>{runtimeFor(selected.slug)?.missing.bins.length ? <section><h4>缺少依赖</h4><p>{runtimeFor(selected.slug)?.missing.bins.join(", ")}</p></section> : null}{runtimeFor(selected.slug)?.conflicts.length ? <section><h4>冲突</h4><p>{runtimeFor(selected.slug)?.conflicts.join(", ")}</p></section> : null}<section className="skill-markdown"><h4>SKILL.md</h4>{detailState === "loading" ? <p>正在读取…</p> : null}{detailState === "error" ? <p role="alert">{detailError}</p> : null}{selectedDetail ? <div className="skill-markdown-reader"><SafeMarkdown text={skillMarkdownBody(selectedDetail.markdown)} /></div> : null}</section></div><footer><button onClick={() => setSelected(undefined)}>关闭</button></footer></aside></div> : null}
    {importCandidate ? <div className="skill-dialog-backdrop"><div className="skill-dialog" role="dialog" aria-modal="true" aria-label={`确认导入 ${importCandidate.detail.name}`}><header><AlertTriangle /><div><strong>高风险安装确认</strong><span>{importCandidate.detail.name} · v{importCandidate.detail.version}</span></div></header><p>包已通过结构与路径校验。安装后将由 OpenClaw 权威读回确认。</p><label className="skill-risk-confirm"><input type="checkbox" checked={confirmed} disabled={importState === "installing"} onChange={(event) => setConfirmed(event.target.checked)} />我已了解网络来源 Skill 的高风险</label><footer><Button disabled={importState === "installing"} onClick={() => void cancelImport()}>取消</Button><Button type="primary" aria-label="确认安装" aria-busy={importState === "installing"} loading={importState === "installing"} disabled={!confirmed || importState === "installing"} onClick={() => void installImport()}>确认安装</Button></footer></div></div> : null}
    </div>
  </section>;
}
