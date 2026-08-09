import type { ActivityCenterService, TaskActivity, TaskActivityState, TaskActivitySnapshot } from "@uclaw/shared";
import { AlertCircle, CheckCircle2, CircleStop, Clock3, LoaderCircle, RefreshCw, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const labels: Record<TaskActivityState, string> = {
  running: "运行中", "waiting-input": "等待输入", succeeded: "成功", failed: "失败", cancelled: "已取消",
};

function StateIcon({ state }: { state: TaskActivityState }) {
  if (state === "running") return <LoaderCircle className="spin" />;
  if (state === "waiting-input") return <Clock3 />;
  if (state === "succeeded") return <CheckCircle2 />;
  if (state === "failed") return <AlertCircle />;
  return <CircleStop />;
}

function TaskRow({ task, onOpenSession, onRefresh }: { task: TaskActivity; onOpenSession(id: string): void; onRefresh(): void }) {
  return <article className={`task-activity-row state-${task.state}`}>
    <span className="task-state-icon"><StateIcon state={task.state} /></span>
    <div className="task-activity-main">
      <header><strong>{task.title}</strong><span className="task-state-label">{labels[task.state]}</span></header>
      <p>{task.sessionTitle}</p>
      <time dateTime={task.updatedAt}>{new Date(task.updatedAt).toLocaleString("zh-CN", { hour12: false })}</time>
      {task.error ? <div className="task-error" role="alert"><strong>{task.error.message}</strong><span>错误码：{task.error.code}</span></div> : null}
      <footer><button type="button" aria-label={`回到${task.sessionTitle}`} onClick={() => onOpenSession(task.sessionId)}>回到会话</button>{task.state === "failed" ? <button type="button" onClick={onRefresh}><RefreshCw />刷新状态</button> : null}</footer>
    </div>
  </article>;
}

export function TaskActivityCenter({ open, service, onClose, onOpenSession }: { open: boolean; service?: ActivityCenterService; onClose(): void; onOpenSession(sessionId: string): void }) {
  const [snapshot, setSnapshot] = useState<TaskActivitySnapshot>();
  const snapshotRef = useRef<TaskActivitySnapshot | undefined>(undefined);
  const [state, setState] = useState<"loading" | "ready" | "error" | "offline" | "recovering">("loading");
  const refresh = useCallback(async (recovering = false) => {
    if (service === undefined) { setState("error"); return; }
    if (!navigator.onLine) { setState("offline"); return; }
    setState(recovering ? "recovering" : snapshotRef.current === undefined ? "loading" : "ready");
    try {
      const next = await service.list();
      snapshotRef.current = next;
      setSnapshot(next);
      setState("ready");
    } catch { setState("error"); }
  }, [service]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    const offline = () => setState("offline");
    const online = () => void refresh(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => { window.clearInterval(interval); window.removeEventListener("offline", offline); window.removeEventListener("online", online); };
  }, [open, refresh]);

  if (!open) return null;
  return <aside className="task-activity-center" aria-label="全局任务活动中心">
    <header><div><strong>任务活动</strong><small>OpenClaw 实时状态</small></div><button type="button" aria-label="关闭任务活动中心" onClick={onClose}><X /></button></header>
    <div className="task-center-toolbar"><span>{snapshot?.tasks.length ?? 0} 个任务</span><button type="button" aria-label="刷新任务状态" onClick={() => void refresh()}><RotateCw />刷新</button></div>
    <div className="task-activity-list">
      {state === "loading" || state === "recovering" ? <div className="task-center-state"><LoaderCircle className="spin" /><strong>{state === "recovering" ? "正在恢复任务状态" : "正在加载任务状态"}</strong></div> : null}
      {state === "offline" ? <div className="task-center-state" role="alert"><AlertCircle /><strong>当前离线</strong><p>连接恢复后将自动重建真实任务状态。</p></div> : null}
      {state === "error" ? <div className="task-center-state" role="alert"><AlertCircle /><strong>任务状态加载失败</strong><p>未使用本地缓存伪造状态。</p><button type="button" onClick={() => void refresh()}>重试</button></div> : null}
      {state === "ready" && snapshot?.tasks.length === 0 ? <div className="task-center-state"><Clock3 /><strong>暂无任务活动</strong></div> : null}
      {state === "ready" ? snapshot?.tasks.map((task) => <TaskRow key={task.id} task={task} onOpenSession={onOpenSession} onRefresh={() => void refresh()} />) : null}
    </div>
  </aside>;
}
