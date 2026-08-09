import type {
  DataBridge,
  DataIpcRequest,
  DataIpcResponse,
  MemoryEntry,
  WorkspaceEntry,
} from "@uclaw/shared";
import { Tooltip } from "antd";
import {
  ExternalLink,
  File,
  FileText,
  Folder,
  FolderInput,
  FolderSearch,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Domain = "workspace" | "memory";
type Entry = WorkspaceEntry | MemoryEntry;
type Availability = "checking" | "available" | "read-only" | "offline";

let requestSequence = 0;
const requestId = (method: string): string => `data-${method}-${Date.now()}-${++requestSequence}`;

const fallbackBridge: DataBridge = {
  async invoke(request): Promise<DataIpcResponse> {
    if (request.method === "data.status") {
      return { method: request.method, requestId: request.requestId, ok: true, result: { state: "read-only", writable: false } };
    }
    if (request.method === "workspace.list" || request.method === "memory.list") {
      return { method: request.method, requestId: request.requestId, ok: true, result: { items: [], nextCursor: null, hasMore: false } };
    }
    return {
      method: request.method,
      requestId: request.requestId,
      ok: false,
      error: { code: "UNAVAILABLE", message: "原生数据服务未连接。", retryable: true, recoveryActions: ["retry"], causeDetails: {} },
    };
  },
};

function entryLabel(entry: Entry): string { return "title" in entry ? entry.title : entry.name; }

export function DataManager({ domain, bridge, onDirtyChange }: { domain: Domain; bridge?: DataBridge; onDirtyChange?(dirty: boolean): void }) {
  const resolvedBridge = bridge ?? window.uclaw?.data ?? fallbackBridge;
  const [items, setItems] = useState<Entry[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [parentId, setParentId] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Entry>();
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [availability, setAvailability] = useState<Availability>("checking");
  const loadGeneration = useRef(0);

  const invoke = useCallback(async (request: DataIpcRequest): Promise<DataIpcResponse> => {
    const response = await resolvedBridge.invoke(request);
    if (!response.ok) throw Object.assign(new Error(response.error.message), { dataCode: response.error.code });
    return response;
  }, [resolvedBridge]);

  const loadStatus = useCallback(async (): Promise<boolean> => {
    try {
      const response = await invoke({ method: "data.status", requestId: requestId("data.status"), params: {} }) as Extract<DataIpcResponse, { ok: true; method: "data.status" }>;
      setAvailability(response.result.state);
      return response.result.state !== "offline";
    } catch (caught) {
      setAvailability("offline");
      setItems([]);
      setSelected(undefined);
      setContent("");
      setSavedContent("");
      setError(caught instanceof Error ? caught.message : "U 盘工作区离线。");
      setState("error");
      return false;
    }
  }, [invoke]);

  const load = useCallback(async (append = false): Promise<boolean> => {
    const generation = ++loadGeneration.current;
    setState("loading");
    setError(undefined);
    try {
      const method = domain === "workspace" ? "workspace.list" : "memory.list";
      const params = domain === "workspace"
        ? { ...(parentId ? { parentId } : {}), ...(query ? { query } : {}), ...(append && nextCursor ? { cursor: nextCursor } : {}), limit: 80 }
        : { ...(query ? { query } : {}), ...(append && nextCursor ? { cursor: nextCursor } : {}), limit: 80 };
      const response = await invoke({ method, requestId: requestId(method), params } as DataIpcRequest) as Extract<DataIpcResponse, { ok: true; method: typeof method }>;
      if (generation !== loadGeneration.current) return false;
      setItems((current) => append ? [...current, ...response.result.items] : response.result.items);
      setNextCursor(response.result.nextCursor);
      setHasMore(response.result.hasMore);
      setState("ready");
      return true;
    } catch (caught) {
      if (generation !== loadGeneration.current) return false;
      setError(caught instanceof Error ? caught.message : "数据加载失败。");
      setState("error");
      const dataCode = (caught as Error & { dataCode?: string }).dataCode;
      if (dataCode === "USB_MISSING" || dataCode === "USB_UNAVAILABLE") {
        setAvailability("offline");
        setItems([]);
        setSelected(undefined);
        setContent("");
        setSavedContent("");
      }
      return false;
    }
  }, [domain, invoke, nextCursor, parentId, query]);

  const refresh = useCallback(async () => {
    setAvailability("checking");
    if (await loadStatus()) await load();
  }, [load, loadStatus]);

  useEffect(() => {
    setItems([]);
    setQuery("");
    setParentId(undefined);
    setNextCursor(null);
    setHasMore(false);
    setSelected(undefined);
    setContent("");
    setSavedContent("");
    setDeleteOpen(false);
  }, [domain]);

  useEffect(() => { void refresh(); }, [domain, parentId, query]);

  const dirty = domain === "memory" && selected !== undefined && content !== savedContent;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [dirty]);

  const openEntry = async (entry: Entry) => {
    if (dirty && selected?.id !== entry.id && !window.confirm("当前记忆尚未保存，放弃修改吗？")) return;
    if (domain === "workspace" && "kind" in entry && entry.kind === "directory") {
      setParentId(entry.id);
      setSelected(undefined);
      setContent("");
      return;
    }
    setDetailLoading(true);
    setError(undefined);
    try {
      const method = domain === "workspace" ? "workspace.read" : "memory.read";
      const params = domain === "workspace" ? { entryId: entry.id } : { memoryId: entry.id };
      const response = await invoke({ method, requestId: requestId(method), params } as DataIpcRequest) as any;
      const nextEntry = domain === "workspace" ? response.result.entry : response.result.memory;
      setSelected(nextEntry);
      setContent(response.result.content);
      setSavedContent(response.result.content);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "内容读取失败。");
    } finally { setDetailLoading(false); }
  };

  const mutate = async (request: DataIpcRequest, refreshAfter = true) => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await invoke(request) as any;
      if (refreshAfter && !(await load())) {
        setError(request.method === "memory.write" ? "记忆已保存，但列表刷新失败。" : "操作已完成，但列表刷新失败。");
      }
      return response;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败。");
      return undefined;
    } finally { setBusy(false); }
  };

  const saveMemory = async () => {
    if (domain !== "memory" || !selected || content === savedContent) return;
    const response = await mutate({
      method: "memory.write",
      requestId: requestId("memory.write"),
      params: { memoryId: selected.id, content, version: selected.version },
    });
    if (response?.result.memory) {
      setSelected(response.result.memory);
      setSavedContent(content);
    }
  };

  const confirmDelete = async () => {
    if (!selected) return;
    const method = domain === "workspace" ? "workspace.delete" : "memory.delete";
    const params = domain === "workspace"
      ? { entryId: selected.id, version: selected.version, confirmed: true as const }
      : { memoryId: selected.id, version: selected.version, confirmed: true as const };
    const response = await mutate({ method, requestId: requestId(method), params } as DataIpcRequest);
    if (response) { setSelected(undefined); setContent(""); setSavedContent(""); setDeleteOpen(false); }
  };

  const renameEntry = async () => {
    if (domain !== "workspace" || !selected) return;
    const current = entryLabel(selected);
    const name = window.prompt("新名称", current)?.trim();
    if (!name || name === current) return;
    const response = await mutate({ method: "workspace.rename", requestId: requestId("workspace.rename"), params: { entryId: selected.id, name, version: selected.version } });
    if (response?.result) setSelected(response.result);
  };

  const moveEntry = async () => {
    if (domain !== "workspace" || !selected) return;
    const destinationId = window.prompt("目标文件夹（留空表示根目录）", "")?.trim();
    if (destinationId === undefined) return;
    const response = await mutate({ method: "workspace.move", requestId: requestId("workspace.move"), params: { entryId: selected.id, ...(destinationId ? { destinationId } : {}), version: selected.version } });
    if (response?.result) setSelected(response.result);
  };

  const title = domain === "workspace" ? "文件" : "记忆";
  const description = domain === "workspace" ? "管理当前 U 盘工作区内的用户文件" : "管理 OpenClaw 实际读取的 Markdown 记忆";
  const emptyText = domain === "workspace" ? "当前文件夹为空" : "还没有 AI 记忆";
  const breadcrumbs = useMemo(() => parentId?.split("/") ?? [], [parentId]);
  const writable = availability === "available";

  return <section className="secondary-view data-manager">
    <header><h1>{title}</h1><p>{description}</p></header>
    <div className="data-toolbar">
      <label className="data-search"><Search aria-hidden="true" /><input type="search" aria-label={domain === "workspace" ? "搜索工作区文件" : "搜索 AI 记忆"} placeholder="搜索" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <Tooltip title="重新加载"><button className="icon-button" type="button" aria-label="重新加载" onClick={() => void refresh()}><RefreshCw /></button></Tooltip>
    </div>
    {domain === "workspace" && parentId ? <nav className="data-breadcrumbs" aria-label="文件路径">
      <button type="button" onClick={() => setParentId(undefined)}>工作区</button>
      {breadcrumbs.map((part, index) => <button key={`${part}-${index}`} type="button" onClick={() => setParentId(breadcrumbs.slice(0, index + 1).join("/"))}>{part}</button>)}
    </nav> : null}
    {availability === "read-only" ? <div className="data-status" role="status">当前工作区只读</div> : null}
    {availability === "offline" && !error ? <div className="data-error" role="alert"><span>U 盘工作区离线。</span><button type="button" onClick={() => void refresh()}>重新加载</button></div> : null}
    {error ? <div className="data-error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>重新加载</button></div> : null}
    <div className="data-layout">
      <section className="data-list" aria-label={`${title}列表`}>
        {state === "loading" && items.length === 0 ? <div className="data-state"><RefreshCw className="spin" /><span>正在加载</span></div> : null}
        {state === "ready" && items.length === 0 ? <div className="data-state"><FolderSearch /><span>{emptyText}</span></div> : null}
        {items.map((entry) => {
          const label = entryLabel(entry);
          const directory = "kind" in entry && entry.kind === "directory";
          return <button key={entry.id} type="button" className={`data-row${selected?.id === entry.id ? " selected" : ""}`} aria-label={`查看 ${label}`} onClick={() => void openEntry(entry)}>
            {directory ? <Folder /> : domain === "memory" ? <FileText /> : <File />}
            <span><strong>{label}</strong><small>{entry.id}</small></span>
            <time>{new Date(entry.modifiedAt).toLocaleDateString("zh-CN")}</time>
          </button>;
        })}
        {hasMore ? <button className="data-more" type="button" onClick={() => void load(true)}>加载更多</button> : null}
      </section>
      <section className="data-detail" aria-label="详情">
        {!selected ? <div className="data-state"><FileText /><span>选择项目查看详情</span></div> : <>
          <div className="data-detail-head"><div><strong>{entryLabel(selected)}</strong><small>{selected.id}</small></div><div className="data-actions">
            {domain === "workspace" ? <>
              <Tooltip title="打开"><button className="icon-button" type="button" aria-label={`打开 ${entryLabel(selected)}`} disabled={busy || availability === "offline"} onClick={() => void mutate({ method: "workspace.open", requestId: requestId("workspace.open"), params: { entryId: selected.id } }, false)}><ExternalLink /></button></Tooltip>
              <Tooltip title="定位"><button className="icon-button" type="button" aria-label={`定位 ${entryLabel(selected)}`} disabled={busy || availability === "offline"} onClick={() => void mutate({ method: "workspace.reveal", requestId: requestId("workspace.reveal"), params: { entryId: selected.id } }, false)}><FolderSearch /></button></Tooltip>
              <Tooltip title="重命名"><button className="icon-button" type="button" aria-label={`重命名 ${entryLabel(selected)}`} disabled={busy || !writable} onClick={() => void renameEntry()}><Pencil /></button></Tooltip>
              <Tooltip title="移动"><button className="icon-button" type="button" aria-label={`移动 ${entryLabel(selected)}`} disabled={busy || !writable} onClick={() => void moveEntry()}><FolderInput /></button></Tooltip>
            </> : <Tooltip title="保存"><button className="icon-button" type="button" aria-label="保存记忆" disabled={busy || !writable || content === savedContent} onClick={() => void saveMemory()}><Save /></button></Tooltip>}
            <Tooltip title="删除"><button className="icon-button danger" type="button" aria-label={`删除 ${entryLabel(selected)}`} disabled={busy || !writable} onClick={() => setDeleteOpen(true)}><Trash2 /></button></Tooltip>
          </div></div>
          {detailLoading ? <div className="data-state"><RefreshCw className="spin" /><span>正在读取</span></div> : <textarea className="data-editor" aria-label={domain === "memory" ? "记忆正文" : "文件内容"} readOnly={domain === "workspace" || !writable} value={content} onChange={(event) => setContent(event.target.value)} />}
        </>}
      </section>
    </div>
    {deleteOpen ? <div className="data-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteOpen(false); }}>
      <div className="data-modal" role="dialog" aria-modal="true" aria-label="确认删除">
        <h2>确认删除</h2>
        <p>删除后无法从应用内恢复。确认删除“{selected ? entryLabel(selected) : ""}”吗？</p>
        <div className="data-confirm-actions"><button type="button" onClick={() => setDeleteOpen(false)}>取消</button><button className="danger-command" type="button" aria-label="确认删除" disabled={busy} onClick={() => void confirmDelete()}>确认删除</button></div>
      </div>
    </div> : null}
  </section>;
}
