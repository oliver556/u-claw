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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

type Domain = "workspace" | "memory";
type Entry = WorkspaceEntry | MemoryEntry;
type Availability = "checking" | "available" | "read-only" | "offline";
type WorkspaceDialog = { kind: "rename" | "move"; value: string };

let requestSequence = 0;
const requestId = (method: string): string => `data-${method}-${Date.now()}-${++requestSequence}`;

const fallbackBridge: DataBridge = {
  async invoke(request): Promise<DataIpcResponse> {
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
  const [workspaceDialog, setWorkspaceDialog] = useState<WorkspaceDialog>();
  const [busy, setBusy] = useState(false);
  const [lastMutation, setLastMutation] = useState("");
  const [availability, setAvailability] = useState<Availability>("checking");
  const loadGeneration = useRef(0);
  const detailGeneration = useRef(0);

  const invoke = useCallback(async (request: DataIpcRequest): Promise<DataIpcResponse> => {
    const response = await resolvedBridge.invoke(request);
    if (!response.ok) throw Object.assign(new Error(response.error.message), { dataCode: response.error.code });
    return response;
  }, [resolvedBridge]);

  const loadStatus = useCallback(async (generation: number): Promise<boolean> => {
    try {
      const response = await invoke({ method: "data.status", requestId: requestId("data.status"), params: {} }) as Extract<DataIpcResponse, { ok: true; method: "data.status" }>;
      if (generation !== loadGeneration.current) return false;
      setAvailability(response.result.state);
      return response.result.state !== "offline";
    } catch (caught) {
      if (generation !== loadGeneration.current) return false;
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

  const load = useCallback(async (append = false, requestedGeneration?: number): Promise<boolean> => {
    const generation = requestedGeneration ?? ++loadGeneration.current;
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
    const generation = ++loadGeneration.current;
    setAvailability("checking");
    if (await loadStatus(generation)) await load(false, generation);
  }, [load, loadStatus]);

  useEffect(() => {
    detailGeneration.current += 1;
    setItems([]);
    setQuery("");
    setParentId(undefined);
    setNextCursor(null);
    setHasMore(false);
    setSelected(undefined);
    setContent("");
    setSavedContent("");
    setDeleteOpen(false);
    setWorkspaceDialog(undefined);
  }, [domain]);

  useEffect(() => { void refresh(); }, [domain, parentId, query]);

  const dirty = domain === "memory" && selected !== undefined && content !== savedContent;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  useLayoutEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const clearSelection = () => {
    detailGeneration.current += 1;
    setSelected(undefined);
    setContent("");
    setSavedContent("");
  };

  const readEntry = async (entryId: string, preserveError = false): Promise<boolean> => {
    const generation = ++detailGeneration.current;
    setSelected(undefined);
    setContent("");
    setSavedContent("");
    setDetailLoading(true);
    if (!preserveError) setError(undefined);
    try {
      const method = domain === "workspace" ? "workspace.read" : "memory.read";
      const params = domain === "workspace" ? { entryId } : { memoryId: entryId };
      const response = await invoke({ method, requestId: requestId(method), params } as DataIpcRequest) as any;
      if (generation !== detailGeneration.current) return false;
      const nextEntry = domain === "workspace" ? response.result.entry : response.result.memory;
      setSelected(nextEntry);
      setContent(response.result.content);
      setSavedContent(response.result.content);
      return true;
    } catch (caught) {
      if (generation !== detailGeneration.current) return false;
      setError(caught instanceof Error ? caught.message : "内容读取失败。");
      return false;
    } finally {
      if (generation === detailGeneration.current) setDetailLoading(false);
    }
  };

  const openEntry = async (entry: Entry) => {
    if (dirty && selected?.id !== entry.id && !window.confirm("当前记忆尚未保存，放弃修改吗？")) return;
    if (domain === "workspace" && "kind" in entry && entry.kind === "directory") {
      detailGeneration.current += 1;
      setParentId(entry.id);
      setSelected(undefined);
      setContent("");
      return;
    }
    await readEntry(entry.id);
  };

  const mutate = async (request: DataIpcRequest, refreshAfter = true, onMutated?: (response: any) => void) => {
    setBusy(true);
    setLastMutation(`${request.method}:pending`);
    setError(undefined);
    try {
      const response = await invoke(request) as any;
      onMutated?.(response);
      let refreshed = true;
      if (refreshAfter && !(await load())) {
        refreshed = false;
        setError(request.method === "memory.write" ? "记忆已保存，但列表刷新失败。" : "操作已完成，但列表刷新失败。");
      }
      setLastMutation(`${request.method}:succeeded`);
      return { response, refreshed };
    } catch (caught) {
      setLastMutation(`${request.method}:failed`);
      setError(caught instanceof Error ? caught.message : "操作失败。");
      return undefined;
    } finally { setBusy(false); }
  };

  const saveMemory = async () => {
    if (domain !== "memory" || !selected || content === savedContent) return;
    const memoryId = selected.id;
    const response = await mutate({
      method: "memory.write",
      requestId: requestId("memory.write"),
      params: { memoryId: selected.id, content, version: selected.version },
    }, true, clearSelection);
    if (response?.response.result.memory) await readEntry(memoryId, !response.refreshed);
  };

  const confirmDelete = async () => {
    if (!selected) return;
    const method = domain === "workspace" ? "workspace.delete" : "memory.delete";
    const params = domain === "workspace"
      ? { entryId: selected.id, version: selected.version, confirmed: true as const }
      : { memoryId: selected.id, version: selected.version, confirmed: true as const };
    const response = await mutate({ method, requestId: requestId(method), params } as DataIpcRequest, true, clearSelection);
    if (response) setDeleteOpen(false);
  };

  const renameEntry = async (name: string) => {
    if (domain !== "workspace" || !selected) return;
    const current = entryLabel(selected);
    if (!name || name === current) { setWorkspaceDialog(undefined); return; }
    const response = await mutate({ method: "workspace.rename", requestId: requestId("workspace.rename"), params: { entryId: selected.id, name, version: selected.version } }, true, clearSelection);
    if (response?.response.result) {
      setWorkspaceDialog(undefined);
      await readEntry(response.response.result.id, !response.refreshed);
    }
  };

  const moveEntry = async (destinationId: string) => {
    if (domain !== "workspace" || !selected) return;
    const response = await mutate({ method: "workspace.move", requestId: requestId("workspace.move"), params: { entryId: selected.id, ...(destinationId ? { destinationId } : {}), version: selected.version } }, true, clearSelection);
    if (response?.response.result) {
      setWorkspaceDialog(undefined);
      await readEntry(response.response.result.id, !response.refreshed);
    }
  };

  const title = domain === "workspace" ? "文件" : "记忆";
  const description = domain === "workspace" ? "管理当前 U 盘工作区内的用户文件" : "管理 OpenClaw 实际读取的 Markdown 记忆";
  const emptyText = domain === "workspace" ? "当前文件夹为空" : "还没有 AI 记忆";
  const breadcrumbs = useMemo(() => parentId?.split("/") ?? [], [parentId]);
  const writable = availability === "available";

  return <section className="secondary-view data-manager" data-last-mutation={lastMutation}>
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
              <Tooltip title="重命名"><button className="icon-button" type="button" aria-label={`重命名 ${entryLabel(selected)}`} disabled={busy || !writable} onClick={() => setWorkspaceDialog({ kind: "rename", value: entryLabel(selected) })}><Pencil /></button></Tooltip>
              <Tooltip title="移动"><button className="icon-button" type="button" aria-label={`移动 ${entryLabel(selected)}`} disabled={busy || !writable} onClick={() => setWorkspaceDialog({ kind: "move", value: "" })}><FolderInput /></button></Tooltip>
            </> : <Tooltip title="保存"><button className="icon-button" type="button" aria-label="保存记忆" disabled={busy || !writable || content === savedContent} onClick={() => void saveMemory()}><Save /></button></Tooltip>}
            <Tooltip title="删除"><button className="icon-button danger" type="button" aria-label={`删除 ${entryLabel(selected)}`} disabled={busy || !writable} onClick={() => setDeleteOpen(true)}><Trash2 /></button></Tooltip>
          </div></div>
          {detailLoading ? <div className="data-state"><RefreshCw className="spin" /><span>正在读取</span></div> : <textarea className="data-editor" aria-label={domain === "memory" ? "记忆正文" : "文件内容"} readOnly={domain === "workspace" || !writable} value={content} onChange={(event) => setContent(event.target.value)} />}
        </>}
      </section>
    </div>
    {workspaceDialog && selected ? <div className="data-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setWorkspaceDialog(undefined); }}>
      <div className="data-modal" role="dialog" aria-modal="true" aria-label={workspaceDialog.kind === "rename" ? "重命名文件" : "移动文件"}>
        <h2>{workspaceDialog.kind === "rename" ? "重命名文件" : "移动文件"}</h2>
        <form className="data-modal-form" onSubmit={(event) => {
          event.preventDefault();
          const value = workspaceDialog.value.trim();
          if (workspaceDialog.kind === "rename") void renameEntry(value);
          else void moveEntry(value);
        }}>
          <label>{workspaceDialog.kind === "rename" ? "新名称" : "目标文件夹"}<input autoFocus maxLength={workspaceDialog.kind === "rename" ? 255 : 1024} placeholder={workspaceDialog.kind === "move" ? "留空表示工作区根目录" : undefined} value={workspaceDialog.value} onChange={(event) => setWorkspaceDialog({ ...workspaceDialog, value: event.target.value })} /></label>
          <div className="data-confirm-actions"><button type="button" disabled={busy} onClick={() => setWorkspaceDialog(undefined)}>取消</button><button type="submit" disabled={busy || (workspaceDialog.kind === "rename" && workspaceDialog.value.trim().length === 0)}>{workspaceDialog.kind === "rename" ? "确认重命名" : "确认移动"}</button></div>
        </form>
      </div>
    </div> : null}
    {deleteOpen ? <div className="data-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteOpen(false); }}>
      <div className="data-modal" role="dialog" aria-modal="true" aria-label="确认删除">
        <h2>确认删除</h2>
        <p>删除后无法从应用内恢复。确认删除“{selected ? entryLabel(selected) : ""}”吗？</p>
        <div className="data-confirm-actions"><button type="button" onClick={() => setDeleteOpen(false)}>取消</button><button className="danger-command" type="button" aria-label="确认删除" disabled={busy} onClick={() => void confirmDelete()}>确认删除</button></div>
      </div>
    </div> : null}
  </section>;
}
