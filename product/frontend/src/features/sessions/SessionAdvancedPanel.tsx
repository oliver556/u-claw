import type {
  SessionAdvancedIpcRequest,
  SessionAdvancedIpcResponse,
  SessionCheckpoint,
  SessionFileEntry,
  Session,
} from "@uclaw/shared";
import { GitBranch, History, LoaderCircle, RefreshCw, RotateCcw, Send, Shrink, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export interface SessionAdvancedBridge {
  invoke(request: SessionAdvancedIpcRequest): Promise<SessionAdvancedIpcResponse>;
}

interface SessionAdvancedPanelProps {
  bridge?: SessionAdvancedBridge;
  sessionId?: string;
  onSessionReadback?(session: Session): void;
}

type LoadState = "loading" | "ready" | "error";

export function SessionAdvancedPanel({ bridge, sessionId, onSessionReadback }: SessionAdvancedPanelProps) {
  const requestSequence = useRef(0);
  const loadSequence = useRef(0);
  const activeScope = useRef({ bridge, sessionId });
  activeScope.current = { bridge, sessionId };
  const [files, setFiles] = useState<SessionFileEntry[]>([]);
  const [checkpoints, setCheckpoints] = useState<SessionCheckpoint[]>([]);
  const [selectedFile, setSelectedFile] = useState<SessionFileEntry>();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [readback, setReadback] = useState<Session>();
  const [maxLines, setMaxLines] = useState("");
  const [steerMessage, setSteerMessage] = useState("");

  const nextRequestId = () => `session-advanced-${++requestSequence.current}`;
  const invoke = useCallback(async (request: SessionAdvancedIpcRequest) => {
    if (bridge === undefined) throw new Error("会话高级操作未配置");
    const response = await bridge.invoke(request);
    if (!response.ok) throw new Error(response.error.message);
    if (response.method !== request.method) throw new Error("会话高级操作响应不匹配");
    return response;
  }, [bridge]);

  const load = useCallback(async () => {
    if (bridge === undefined || sessionId === undefined) return;
    const sequence = ++loadSequence.current;
    const isCurrent = () => sequence === loadSequence.current && activeScope.current.bridge === bridge && activeScope.current.sessionId === sessionId;
    setLoadState("loading");
    setError(undefined);
    setSelectedFile(undefined);
    try {
      const [fileResponse, checkpointResponse] = await Promise.all([
        invoke({ method: "sessions.files.list", requestId: nextRequestId(), params: { sessionId } }),
        invoke({ method: "sessions.checkpoints.list", requestId: nextRequestId(), params: { sessionId } }),
      ]);
      if (fileResponse.method !== "sessions.files.list" || checkpointResponse.method !== "sessions.checkpoints.list") {
        throw new Error("会话高级操作响应不匹配");
      }
      if (!isCurrent()) return;
      setFiles(fileResponse.result.files);
      setCheckpoints(checkpointResponse.result.checkpoints);
      setLoadState("ready");
    } catch (reason) {
      if (!isCurrent()) return;
      setFiles([]);
      setCheckpoints([]);
      setLoadState("error");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [bridge, invoke, sessionId]);

  useEffect(() => {
    setFiles([]);
    setCheckpoints([]);
    setSelectedFile(undefined);
    setReadback(undefined);
    setBusy(false);
    if (bridge === undefined || sessionId === undefined) return;
    void load();
  }, [bridge, load, sessionId]);

  const readFile = async (file: SessionFileEntry) => {
    if (sessionId === undefined) return;
    const scope = activeScope.current;
    setError(undefined);
    try {
      const response = await invoke({ method: "sessions.files.get", requestId: nextRequestId(), params: { sessionId, path: file.path } });
      if (response.method !== "sessions.files.get") throw new Error("会话文件响应不匹配");
      if (activeScope.current.bridge !== scope.bridge || activeScope.current.sessionId !== scope.sessionId) return;
      setSelectedFile(response.result.file);
    } catch (reason) {
      if (activeScope.current.bridge !== scope.bridge || activeScope.current.sessionId !== scope.sessionId) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const publish = (session: Session) => {
    setReadback(session);
    onSessionReadback?.(session);
  };

  const mutate = async (operation: () => Promise<Session>) => {
    if (busy) return;
    const scope = activeScope.current;
    setBusy(true);
    setError(undefined);
    try {
      const session = await operation();
      if (activeScope.current.bridge === scope.bridge && activeScope.current.sessionId === scope.sessionId) publish(session);
    } catch (reason) {
      if (activeScope.current.bridge === scope.bridge && activeScope.current.sessionId === scope.sessionId) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (activeScope.current.bridge === scope.bridge && activeScope.current.sessionId === scope.sessionId) setBusy(false);
    }
  };

  if (bridge === undefined) return <div className="empty-panel"><History /><strong>会话高级操作未配置</strong></div>;
  if (sessionId === undefined) return <div className="empty-panel"><History /><strong>未选择会话</strong></div>;

  return <section className="session-advanced-panel" aria-busy={loadState === "loading" || busy}>
    <header className="data-toolbar">
      <strong>会话文件与历史</strong>
      <button type="button" aria-label="刷新会话文件" disabled={loadState === "loading" || busy} onClick={() => void load()}><RefreshCw /></button>
    </header>
    {loadState === "loading" ? <div className="data-state"><LoaderCircle className="spin" /><strong>正在加载会话文件</strong></div> : null}
    {error ? <div className="data-state" role="alert"><strong>操作失败</strong><small>{error}</small></div> : null}
    {loadState === "ready" && files.length === 0 ? <div className="data-state"><strong>当前会话没有关联文件</strong></div> : null}
    {files.length > 0 ? <div className="file-list" aria-label="会话文件">{files.map((file) => <button
      className="file-row" type="button" key={file.path} aria-label={`读取 ${file.name}`} disabled={busy || file.missing}
      onClick={() => void readFile(file)}
    ><span><strong>{file.name}</strong><small>{file.path} · {file.kind === "modified" ? "已修改" : "已读取"}</small></span></button>)}</div> : null}
    {selectedFile ? <pre aria-label={`${selectedFile.name} 内容`}>{selectedFile.content ?? "文件内容不可用"}</pre> : null}

    <div className="data-toolbar"><strong>高级操作</strong>{busy ? <span role="status"><LoaderCircle className="spin" />正在执行</span> : null}</div>
    <div className="session-advanced-actions">
      <button type="button" disabled={busy} onClick={() => {
        if (!window.confirm("重置会话会创建新的会话状态，是否继续？")) return;
        void mutate(async () => {
          const response = await invoke({ method: "sessions.reset", requestId: nextRequestId(), params: { sessionId } });
          if (response.method !== "sessions.reset") throw new Error("会话重置响应不匹配");
          void load();
          return response.result.session;
        });
      }}><RotateCcw />重置会话</button>
      <label>保留最近行数<input aria-label="保留最近行数" type="number" min="1" step="1" value={maxLines} disabled={busy} onChange={(event) => setMaxLines(event.target.value)} /></label>
      <button type="button" disabled={busy} onClick={() => void mutate(async () => {
        const parsedMaxLines = maxLines === "" ? undefined : Number(maxLines);
        const response = await invoke({ method: "sessions.compact", requestId: nextRequestId(), params: { sessionId, ...(parsedMaxLines === undefined ? {} : { maxLines: parsedMaxLines }) } });
        if (response.method !== "sessions.compact") throw new Error("会话压缩响应不匹配");
        setCheckpoints(response.result.checkpoints);
        return response.result.session;
      })}><Shrink />压缩会话</button>
    </div>

    <div className="session-checkpoints" aria-label="会话检查点">
      {checkpoints.length === 0 && loadState === "ready" ? <p>暂无检查点</p> : checkpoints.map((item) => <article key={item.checkpointId}>
        <span><strong>{item.checkpointId}</strong><small>{new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })}</small></span>
        <button type="button" aria-label={`从 ${item.checkpointId} 创建分支`} disabled={busy} onClick={() => void mutate(async () => {
          const response = await invoke({ method: "sessions.branch", requestId: nextRequestId(), params: { sessionId, checkpointId: item.checkpointId } });
          if (response.method !== "sessions.branch") throw new Error("会话分支响应不匹配");
          return response.result.session;
        })}><GitBranch /></button>
        <button type="button" aria-label={`恢复到 ${item.checkpointId}`} disabled={busy} onClick={() => {
          if (!window.confirm(`恢复到检查点 ${item.checkpointId} 会覆盖当前会话状态，是否继续？`)) return;
          void mutate(async () => {
            const response = await invoke({ method: "sessions.restore", requestId: nextRequestId(), params: { sessionId, checkpointId: item.checkpointId } });
            if (response.method !== "sessions.restore") throw new Error("会话恢复响应不匹配");
            void load();
            return response.result.session;
          });
        }}><Undo2 /></button>
      </article>)}
    </div>

    <div className="session-steer">
      <label>引导消息<textarea aria-label="引导消息" value={steerMessage} disabled={busy} onChange={(event) => setSteerMessage(event.target.value)} /></label>
      <button type="button" disabled={busy || steerMessage.trim() === ""} onClick={() => void mutate(async () => {
        const response = await invoke({ method: "sessions.steer", requestId: nextRequestId(), params: { sessionId, message: steerMessage.trim() } });
        if (response.method !== "sessions.steer") throw new Error("会话引导响应不匹配");
        setSteerMessage("");
        return response.result.session;
      })}><Send />发送引导</button>
    </div>
    {readback ? <div className="data-state" role="status"><strong>{readback.title}</strong><small>权威读回 · {new Date(readback.updatedAt).toLocaleString("zh-CN", { hour12: false })}</small></div> : null}
  </section>;
}
