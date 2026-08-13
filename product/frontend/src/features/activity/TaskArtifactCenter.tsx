import { Download, ExternalLink, FileText, LoaderCircle, RefreshCw, RotateCcw, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type Task = { id: string; title: string; status: "queued" | "running" | "waiting-input" | "succeeded" | "failed" | "cancelled"; sessionId?: string; createdAt: string; updatedAt: string; progress?: number; error?: { message: string } };
type Artifact = { id: string; name: string; mediaType: string; size: number; status: string; sessionId?: string; taskId?: string; createdAt: string };
type Request = { method: string; requestId: string; params: Record<string, unknown> };
type Response = { ok: boolean; result?: unknown; error?: { message: string } };
type Invoke = (request: Request) => Promise<Response>;
type Subscribe = (listener: (event: { event: "task"; payload: { type: string; task: Task } }) => void) => () => void;

export interface TaskArtifactCenterProps { invoke?: Invoke; subscribe?: Subscribe; onOpenSession(sessionId: string): void; onClose?(): void; }

export function TaskArtifactCenter({ invoke: suppliedInvoke, subscribe: suppliedSubscribe, onOpenSession, onClose }: TaskArtifactCenterProps) {
  const bridge = (window as unknown as { uclaw?: { taskArtifacts?: { invoke: Invoke; subscribe: Subscribe } } }).uclaw?.taskArtifacts;
  const invoke = suppliedInvoke ?? bridge?.invoke;
  const subscribe = suppliedSubscribe ?? bridge?.subscribe;
  const sequence = useRef(0);
  const [tab, setTab] = useState<"active" | "history" | "artifacts">("active");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [detail, setDetail] = useState<Task>();
  const [artifactDetail, setArtifactDetail] = useState<Artifact>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const call = useCallback(async (method: string, params: Record<string, unknown> = {}) => {
    if (!invoke) throw new Error("Task/Artifact RPC 未配置");
    const response = await invoke({ method, requestId: `task-artifact-${++sequence.current}`, params });
    if (!response.ok) throw new Error(response.error?.message ?? "Task/Artifact 操作失败");
    return response.result;
  }, [invoke]);
  const refresh = useCallback(async () => {
    setBusy(true); setError(undefined);
    try {
      const [nextTasks, nextArtifacts] = await Promise.all([call("tasks.list"), call("artifacts.list")]);
      setTasks(nextTasks as Task[]); setArtifacts(nextArtifacts as Artifact[]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }, [call]);
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (invoke) void refresh(); }, [invoke, refresh]);
  useEffect(() => subscribe?.((event) => setTasks((current) => event.payload.type === "removed"
    ? current.filter((item) => item.id !== event.payload.task.id)
    : [event.payload.task, ...current.filter((item) => item.id !== event.payload.task.id)])), [subscribe]);

  if (!invoke) return <div className="empty-panel"><FileText /><strong>Task/Artifact RPC 未配置</strong></div>;
  const active = tasks.filter((task) => ["queued", "running", "waiting-input"].includes(task.status));
  const history = tasks.filter((task) => !["queued", "running", "waiting-input"].includes(task.status));
  const shown = tab === "active" ? active : history;

  return <section className="task-artifact-center" aria-label="Task 活动中心" aria-busy={busy}>
    <header className="data-toolbar"><strong>Task 活动中心</strong><span><button type="button" aria-label="刷新 Task 和成果" disabled={busy} onClick={() => void refresh()}><RefreshCw /></button>{onClose ? <button type="button" aria-label="关闭任务活动中心" onClick={onClose}><X /></button> : null}{busy ? <LoaderCircle className="spin" /> : null}</span></header>
    <div role="tablist" className="settings-tabs">
      <button role="tab" aria-selected={tab === "active"} onClick={() => setTab("active")}>运行中</button>
      <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>历史</button>
      <button role="tab" aria-selected={tab === "artifacts"} onClick={() => setTab("artifacts")}>成果</button>
    </div>
    {error ? <div role="alert" className="data-state"><strong>操作失败</strong><small>{error}</small></div> : null}
    {tab !== "artifacts" ? <div className="automation-grid">
      <section>{shown.map((task) => <article key={task.id}>
        <button disabled={busy} aria-label={`查看任务 ${task.title}`} onClick={() => void run(async () => { const next = await call("tasks.get", { taskId: task.id }) as Task; setDetail(next); setTasks((current) => [next, ...current.filter((item) => item.id !== next.id)]); })}>{task.title}<small>{task.status}</small></button>
        {["queued", "running", "waiting-input"].includes(task.status) ? <button aria-label={`取消任务 ${task.title}`} disabled={busy} onClick={() => void run(async () => { await call("tasks.cancel", { taskId: task.id }); await refresh(); })}><Square /></button> : null}
        {["failed", "cancelled"].includes(task.status) ? <button aria-label={`重试任务 ${task.title}`} disabled={busy} onClick={() => void run(async () => { await call("tasks.retry", { taskId: task.id }); await refresh(); })}><RotateCcw /></button> : null}
      </article>)}</section>
      <section aria-label="Task 详情"><strong>Task 详情</strong>{detail ? <article><h3>{detail.title}</h3><p>{detail.status}</p>{detail.error ? <p>{detail.error.message}</p> : null}{detail.sessionId ? <button onClick={() => onOpenSession(detail.sessionId!)}><ExternalLink />回到来源会话</button> : null}<button aria-label="关闭 Task 详情" onClick={() => setDetail(undefined)}><X /></button></article> : null}</section>
    </div> : <div className="automation-grid">
      <section>{artifacts.map((artifact) => <article key={artifact.id}>
        <button disabled={busy} aria-label={`查看成果 ${artifact.name}`} onClick={() => void run(async () => setArtifactDetail(await call("artifacts.get", { artifactId: artifact.id }) as Artifact))}><FileText />{artifact.name}</button>
        <span><small>{artifact.mediaType} · {artifact.size} B</small></span>
        <button disabled={busy} aria-label={`下载成果 ${artifact.name}`} onClick={() => void run(async () => { await call("artifacts.download", { artifactId: artifact.id }); })}><Download /></button>
        <button disabled={busy} aria-label={`打开成果 ${artifact.name}`} onClick={() => void run(async () => { await call("artifacts.download", { artifactId: artifact.id }); await call("artifacts.open", { artifactId: artifact.id }); })}><ExternalLink /></button>
        <button disabled={busy} aria-label={`导出成果 ${artifact.name}`} onClick={() => void run(async () => { await call("artifacts.download", { artifactId: artifact.id }); await call("artifacts.export", { artifactId: artifact.id }); })}><Download /></button>
        {artifact.sessionId ? <button disabled={busy} aria-label={`回到成果来源会话 ${artifact.name}`} onClick={() => onOpenSession(artifact.sessionId!)}>来源会话</button> : null}
      </article>)}</section>
      <section aria-label="成果详情"><strong>成果详情</strong>{artifactDetail ? <article><h3>{artifactDetail.name}</h3><p>{artifactDetail.mediaType} · {artifactDetail.size} B · {artifactDetail.status}</p>{artifactDetail.sessionId ? <button onClick={() => onOpenSession(artifactDetail.sessionId!)}>回到来源会话</button> : null}</article> : null}</section>
    </div>}
  </section>;
}
