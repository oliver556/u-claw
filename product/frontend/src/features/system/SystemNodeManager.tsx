import type { SystemNodeIpcEvent, SystemNodeIpcRequest, SystemNodeIpcResponse } from "@uclaw/shared/dist/system-node.js";
import { Box, Cpu, KeyRound, Laptop, LoaderCircle, Play, RefreshCw, RotateCcw, SquareTerminal, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import "./SystemNodeManager.css";

type Invoke = (request: SystemNodeIpcRequest) => Promise<SystemNodeIpcResponse>;
export interface SystemNodeBridge { invoke: Invoke; subscribe(listener: (event: SystemNodeIpcEvent) => void): () => void; }
type View = "devices" | "nodes" | "environments" | "worktrees" | "terminal";
type Row = Record<string, unknown>;
const TERMINAL_SCROLLBACK_CHARS = 256 * 1024;

function rows(value: unknown, key: string): Row[] { return value && typeof value === "object" && Array.isArray((value as Row)[key]) ? (value as Row)[key] as Row[] : []; }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function authority(value: unknown): unknown { return value && typeof value === "object" && "authority" in value ? (value as Row).authority : value; }
function appendTerminalText(current: string, next: string): string { return (current + next).slice(-TERMINAL_SCROLLBACK_CHARS); }

export function SystemNodeManager({ bridge }: { bridge?: SystemNodeBridge }) {
  const sequence = useRef(0);
  const terminalSeq = useRef(new Map<string, number>());
  const [view, setView] = useState<View>("devices");
  const [devices, setDevices] = useState<{ pending: Row[]; paired: Row[] }>({ pending: [], paired: [] });
  const [nodes, setNodes] = useState<Row[]>([]); const [nodePairs, setNodePairs] = useState<Row[]>([]);
  const [nodeDetail, setNodeDetail] = useState<Row>(); const [nodeName, setNodeName] = useState(""); const [environmentDetail, setEnvironmentDetail] = useState<Row>();
  const [environments, setEnvironments] = useState<Row[]>([]); const [worktrees, setWorktrees] = useState<Row[]>([]); const [terminals, setTerminals] = useState<Row[]>([]);
  const [terminalId, setTerminalId] = useState<string>(); const [terminalText, setTerminalText] = useState(""); const [terminalInput, setTerminalInput] = useState("");
  const [terminalCols, setTerminalCols] = useState(100); const [terminalRows, setTerminalRows] = useState(30);
  const [repoRoot, setRepoRoot] = useState(""); const [worktreeName, setWorktreeName] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  const call = useCallback(async (method: SystemNodeIpcRequest["method"], params: Record<string, unknown>) => {
    if (!bridge) throw new Error("设备与运行 RPC 未配置");
    const response = await bridge.invoke({ method, requestId: `system-node-${++sequence.current}`, params } as SystemNodeIpcRequest);
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    return response.result;
  }, [bridge]);
  const run = async (operation: () => Promise<void>) => { setBusy(true); setError(undefined); try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  const refresh = useCallback(async (target: View) => {
    if (target === "devices") { const value = await call("device.pair.list", {}); setDevices({ pending: rows(value, "pending"), paired: rows(value, "paired") }); }
    if (target === "nodes") { const [value, pairs] = await Promise.all([call("node.list", {}), call("node.pair.list", {})]); setNodes(rows(value, "nodes")); setNodePairs([...rows(pairs, "pending"), ...rows(pairs, "paired")]); }
    if (target === "environments") setEnvironments(rows(await call("environments.list", {}), "environments"));
    if (target === "worktrees") setWorktrees(rows(await call("worktrees.list", {}), "worktrees"));
    if (target === "terminal") setTerminals(rows(await call("terminal.list", {}), "sessions"));
  }, [call]);
  useEffect(() => { if (bridge) void run(() => refresh(view)); }, [bridge, refresh, view]);
  useEffect(() => bridge?.subscribe((event) => {
    if (event.event === "terminal.data" && event.payload.sessionId === terminalId) {
      const previous = terminalSeq.current.get(event.payload.sessionId) ?? -1;
      if (event.payload.seq <= previous) return;
      terminalSeq.current.set(event.payload.sessionId, event.payload.seq);
      if (previous >= 0 && event.payload.seq > previous + 1) void run(async () => { const value = await call("terminal.text", { sessionId: event.payload.sessionId }) as Row; setTerminalText(text(value.text).slice(-TERMINAL_SCROLLBACK_CHARS)); });
      else setTerminalText((current) => appendTerminalText(current, event.payload.data));
    }
    if (event.event.endsWith("pair.requested") || event.event.endsWith("pair.resolved")) void refresh(event.event.startsWith("device") ? "devices" : "nodes");
    if (event.event === "terminal.exit") { terminalSeq.current.delete(event.payload.sessionId); if (event.payload.sessionId === terminalId) setTerminalText(""); void refresh("terminal"); }
  }), [bridge, refresh, terminalId]);
  useEffect(() => () => { terminalSeq.current.clear(); setTerminalText(""); setTerminalInput(""); }, []);
  if (!bridge) return <div className="empty-panel"><Cpu /><strong>设备与运行 RPC 未配置</strong></div>;
  const switchView = (next: View) => { setView(next); setError(undefined); };
  const readbackDevices = (value: unknown) => { const next = authority(value); setDevices({ pending: rows(next, "pending"), paired: rows(next, "paired") }); };
  const mutateDevice = (method: "device.pair.approve" | "device.pair.reject", requestId: string) => run(async () => readbackDevices(await call(method, { requestId })));
  const removeDevice = (deviceId: string) => run(async () => readbackDevices(await call("device.pair.remove", { deviceId })));
  const rotate = (deviceId: string) => run(async () => { const value = await call("device.token.rotate", { deviceId, role: "operator" }); readbackDevices(value); });
  const loadNode = (nodeId: string) => run(async () => { const value = await call("node.describe", { nodeId }) as Row; setNodeDetail(value); setNodeName(text(value.displayName)); });
  const mutateNodePair = (method: "node.pair.approve" | "node.pair.reject", requestId: string) => run(async () => { await call(method, { requestId }); await refresh("nodes"); });
  return <section className="system-node-manager" aria-label="设备与运行" aria-busy={busy}>
    <header className="data-toolbar"><strong>设备、Node 与运行环境</strong><button type="button" aria-label="刷新设备与运行" disabled={busy} onClick={() => void run(() => refresh(view))}><RefreshCw /></button>{busy ? <LoaderCircle className="spin" /> : null}</header>
    <div role="tablist" className="system-node-tabs">
      <button role="tab" aria-selected={view === "devices"} onClick={() => switchView("devices")}><Laptop />设备</button>
      <button role="tab" aria-selected={view === "nodes"} onClick={() => switchView("nodes")}><Cpu />Node</button>
      <button role="tab" aria-selected={view === "environments"} onClick={() => switchView("environments")}><Box />运行环境</button>
      <button role="tab" aria-selected={view === "worktrees"} onClick={() => switchView("worktrees")}><RotateCcw />Worktree</button>
      <button role="tab" aria-selected={view === "terminal"} onClick={() => switchView("terminal")}><SquareTerminal />Terminal</button>
    </div>
    {error ? <div role="alert" className="data-state"><strong>操作失败</strong><small>{error}</small></div> : null}
    <div className="system-node-content">
      {view === "devices" ? <div className="system-node-list"><h2>待配对</h2>{devices.pending.map((item) => <article key={text(item.requestId)}><span><strong>{text(item.displayName) || text(item.deviceId)}</strong><small>{text(item.deviceId)}</small></span><button aria-label={`批准设备 ${text(item.deviceId)}`} onClick={() => void mutateDevice("device.pair.approve", text(item.requestId))}>批准</button><button aria-label={`拒绝设备 ${text(item.deviceId)}`} onClick={() => void mutateDevice("device.pair.reject", text(item.requestId))}><X /></button></article>)}<h2>已配对</h2>{devices.paired.map((item) => <article key={text(item.deviceId)}><span><strong>{text(item.displayName) || text(item.deviceId)}</strong><small>{text(item.deviceId)}</small></span><button aria-label={`轮换设备 Token ${text(item.deviceId)}`} onClick={() => void rotate(text(item.deviceId))}><KeyRound /></button><button aria-label={`撤销设备 Token ${text(item.deviceId)}`} onClick={() => void run(async () => readbackDevices(await call("device.token.revoke", { deviceId: text(item.deviceId), role: "operator" })))}><X /></button><button aria-label={`移除设备 ${text(item.deviceId)}`} onClick={() => void removeDevice(text(item.deviceId))}><Trash2 /></button></article>)}</div> : null}
      {view === "nodes" ? <div className="system-node-list"><h2>Node</h2>{nodes.map((item) => <article key={text(item.nodeId)}><span><strong>{text(item.displayName) || text(item.nodeId)}</strong><small>{item.connected ? "在线" : "离线"} · {text(item.nodeId)}</small></span><button aria-label={`查看 Node ${text(item.nodeId)}`} onClick={() => void loadNode(text(item.nodeId))}>详情</button><button aria-label={`调用 Node ${text(item.nodeId)}`} disabled={!item.connected} onClick={() => void run(async () => { await call("node.invoke", { nodeId: text(item.nodeId), command: "system.info", params: {}, idempotencyKey: `ui-${Date.now()}` }); })}><Play /></button><button aria-label={`移除 Node ${text(item.nodeId)}`} onClick={() => void run(async () => { await call("node.pair.remove", { nodeId: text(item.nodeId) }); await refresh("nodes"); })}><Trash2 /></button></article>)}{nodeDetail ? <div className="system-node-detail"><strong>{text(nodeDetail.nodeId)}</strong><input aria-label="Node 显示名称" value={nodeName} onChange={(event) => setNodeName(event.target.value)} /><button aria-label="重命名 Node" disabled={!nodeName.trim()} onClick={() => void run(async () => { const value = await call("node.rename", { nodeId: text(nodeDetail.nodeId), displayName: nodeName.trim() }) as { authority?: Row }; setNodeDetail(value.authority); await refresh("nodes"); })}>保存名称</button><pre>{JSON.stringify(nodeDetail, null, 2)}</pre></div> : null}<h2>配对</h2>{nodePairs.map((item) => <article key={text(item.requestId) || text(item.nodeId)}><span><strong>{text(item.displayName) || text(item.nodeId)}</strong><small>{text(item.nodeId)}</small></span>{item.requestId ? <><button aria-label={`批准 Node ${text(item.nodeId)}`} onClick={() => void mutateNodePair("node.pair.approve", text(item.requestId))}>批准</button><button aria-label={`拒绝 Node ${text(item.nodeId)}`} onClick={() => void mutateNodePair("node.pair.reject", text(item.requestId))}><X /></button></> : null}</article>)}</div> : null}
      {view === "environments" ? <div className="system-node-list">{environments.map((item) => <article key={text(item.id)}><span><strong>{text(item.label) || text(item.id)}</strong><small>{text(item.type)}</small></span><em className={`runtime-status ${text(item.status)}`}>{text(item.status)}</em><button aria-label={`查看运行环境 ${text(item.id)}`} onClick={() => void run(async () => setEnvironmentDetail(await call("environments.status", { environmentId: text(item.id) }) as Row))}>详情</button></article>)}{environmentDetail ? <pre className="system-node-detail">{JSON.stringify(environmentDetail, null, 2)}</pre> : null}</div> : null}
      {view === "worktrees" ? <div className="system-node-list"><div className="system-node-create"><input aria-label="Git 仓库根目录" value={repoRoot} onChange={(event) => setRepoRoot(event.target.value)} placeholder="Git 仓库根目录" /><input aria-label="Worktree 名称" value={worktreeName} onChange={(event) => setWorktreeName(event.target.value)} placeholder="名称" /><button aria-label="创建 Worktree" disabled={!repoRoot.trim()} onClick={() => void run(async () => { const value = authority(await call("worktrees.create", { repoRoot: repoRoot.trim(), ...(worktreeName.trim() ? { name: worktreeName.trim() } : {}) })); setWorktrees(rows(value, "worktrees")); })}>创建</button><button aria-label="清理 Worktree" onClick={() => void run(async () => setWorktrees(rows(authority(await call("worktrees.gc", {})), "worktrees")))}><RefreshCw /></button></div>{worktrees.map((item) => <article key={text(item.id)}><span><strong>{text(item.name)}</strong><small>{text(item.branch)} · {text(item.path)}</small></span>{item.removedAt ? <button aria-label={`恢复 Worktree ${text(item.id)}`} onClick={() => void run(async () => setWorktrees(rows(authority(await call("worktrees.restore", { id: text(item.id) })), "worktrees")))}><RotateCcw /></button> : <button aria-label={`删除 Worktree ${text(item.id)}`} onClick={() => void run(async () => setWorktrees(rows(authority(await call("worktrees.remove", { id: text(item.id), force: false })), "worktrees")))}><Trash2 /></button>}</article>)}</div> : null}
      {view === "terminal" ? <div className="terminal-workspace"><aside>{terminals.map((item) => <button key={text(item.sessionId)} onClick={() => { const id = text(item.sessionId); terminalSeq.current.delete(id); setTerminalId(id); void run(async () => { const value = await call("terminal.attach", { sessionId: id }) as Row; setTerminalText(text(value.buffer).slice(-TERMINAL_SCROLLBACK_CHARS)); }); }}><strong>{text(item.sessionId)}</strong><small>{text(item.agentId)} · {text(item.cwd)}</small></button>)}<button aria-label="打开 Terminal" onClick={() => void run(async () => { const value = await call("terminal.open", { agentId: "main", cols: terminalCols, rows: terminalRows }) as { mutation?: Row; authority?: Row }; const id = text(value.mutation?.sessionId); terminalSeq.current.delete(id); setTerminalId(id); setTerminals(rows(value.authority, "sessions")); setTerminalText(""); })}><Play />打开</button></aside><div><pre aria-label="Terminal 输出">{terminalText}</pre><div className="terminal-controls"><input aria-label="Terminal 输入" value={terminalInput} onChange={(event) => setTerminalInput(event.target.value)} /><button aria-label="发送 Terminal 输入" disabled={!terminalId || !terminalInput} onClick={() => void run(async () => { await call("terminal.input", { sessionId: terminalId, data: terminalInput }); setTerminalInput(""); })}>发送</button><input aria-label="Terminal 列数" type="number" min={20} max={500} value={terminalCols} onChange={(event) => setTerminalCols(Number(event.target.value))} /><input aria-label="Terminal 行数" type="number" min={5} max={200} value={terminalRows} onChange={(event) => setTerminalRows(Number(event.target.value))} /><button aria-label="调整 Terminal 大小" disabled={!terminalId || terminalCols < 20 || terminalCols > 500 || terminalRows < 5 || terminalRows > 200} onClick={() => void run(async () => { await call("terminal.resize", { sessionId: terminalId, cols: terminalCols, rows: terminalRows }); })}>调整</button><button aria-label="读取 Terminal 输出" disabled={!terminalId} onClick={() => void run(async () => { const value = await call("terminal.text", { sessionId: terminalId }) as Row; setTerminalText(text(value.text).slice(-TERMINAL_SCROLLBACK_CHARS)); })}><RefreshCw /></button><button aria-label="关闭 Terminal" disabled={!terminalId} onClick={() => { const id = terminalId; if (!id) return; void run(async () => { const value = await call("terminal.close", { sessionId: id }); setTerminals(rows(authority(value), "sessions")); terminalSeq.current.delete(id); setTerminalId(undefined); setTerminalText(""); }); }}><X /></button></div></div></div> : null}
    </div>
  </section>;
}
