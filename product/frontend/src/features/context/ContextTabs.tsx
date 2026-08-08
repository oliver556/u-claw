import type { CapabilitySet, FileRef, Message, Session, ToolCall, UClawClient } from "@uclaw/shared";
import { Activity, Brain, FileText, Hammer, Link2, PackageCheck, Paperclip } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const tabs = ["上下文", "记忆", "活动"] as const;
const tabIds = { 上下文: "context", 记忆: "memory", 活动: "activity" } as const;

type ContextKind = "attachment" | "reference" | "memory" | "tool" | "artifact";

interface ContextStep {
  id: string;
  label: string;
}

interface ContextEntry {
  id: string;
  kind: ContextKind;
  label: string;
  detail?: string;
  summary?: Record<string, string | number | boolean | null | Array<string | number | boolean | null>>;
  step: ContextStep;
}

interface ContextSnapshot {
  sessionId: string;
  attachments: ContextEntry[];
  references: ContextEntry[];
  memories: ContextEntry[];
  tools: ContextEntry[];
  artifacts: ContextEntry[];
}

interface ContextTabsProps {
  client: UClawClient;
  session?: Session;
  capabilities?: CapabilitySet;
  activity: string[];
}

function stepFor(message: Message, index: number): ContextStep {
  const text = message.blocks.find((block) => block.type === "text");
  const label = text?.type === "text" ? text.text.replace(/\s+/g, " ").trim() : "";
  return { id: message.id, label: label === "" ? `步骤 ${index + 1}` : label.slice(0, 80) };
}

function fileEntry(kind: "attachment" | "reference" | "artifact", file: FileRef, step: ContextStep): ContextEntry {
  return { id: `${kind}:${file.id}:${step.id}`, kind, label: file.name, detail: file.mediaType, step };
}

function addEntry(entries: ContextEntry[], entry: ContextEntry) {
  if (!entries.some((current) => current.id === entry.id)) entries.push(entry);
}

function buildSnapshot(sessionId: string, messages: Message[], tools: Map<string, ToolCall>): ContextSnapshot {
  const snapshot: ContextSnapshot = { sessionId, attachments: [], references: [], memories: [], tools: [], artifacts: [] };
  messages.filter((message) => message.sessionId === sessionId).forEach((message, index) => {
    const step = stepFor(message, index);
    message.blocks.forEach((block) => {
      if (block.type === "file" || block.type === "image") {
        if (block.file.kind === "attachment") addEntry(snapshot.attachments, fileEntry("attachment", block.file, step));
        else if (block.file.kind === "artifact") addEntry(snapshot.artifacts, fileEntry("artifact", block.file, step));
        else addEntry(snapshot.references, fileEntry("reference", block.file, step));
      } else if (block.type === "citation") {
        const entry: ContextEntry = { id: `${block.source.kind}:${block.source.id}:${step.id}`, kind: block.source.kind === "memory" ? "memory" : "reference", label: block.label, detail: block.excerpt, step };
        if (entry.kind === "memory") addEntry(snapshot.memories, entry);
        else addEntry(snapshot.references, entry);
      } else if (block.type === "tool-call") {
        const tool = tools.get(block.toolCallId);
        addEntry(snapshot.tools, tool === undefined
          ? { id: `tool:${block.toolCallId}:${step.id}`, kind: "tool", label: "工具结果暂不可用", detail: block.toolCallId, step }
          : { id: `tool:${tool.id}:${step.id}`, kind: "tool", label: tool.displayName, detail: tool.state, summary: { ...tool.inputSummary, ...tool.outputSummary }, step });
      }
    });
  });
  return snapshot;
}

async function listSessionMessages(client: UClawClient, sessionId: string) {
  const messages: Message[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await client.chat.list(sessionId, cursor === undefined ? undefined : { cursor });
    messages.push(...page.items);
    if (!page.hasMore || page.nextCursor === null || seenCursors.has(page.nextCursor)) return messages;
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

async function loadSnapshot(client: UClawClient, sessionId: string) {
  const messages = await listSessionMessages(client, sessionId);
  const toolIds = [...new Set(messages.flatMap((message) => message.blocks.flatMap((block) => block.type === "tool-call" ? [block.toolCallId] : [])))];
  const results = await Promise.all(toolIds.map(async (id) => {
    try { return await client.tools.getCall(id); }
    catch { return undefined; }
  }));
  return buildSnapshot(sessionId, messages, new Map(results.filter((tool): tool is ToolCall => tool !== undefined).map((tool) => [tool.id, tool])));
}

function summaryLines(summary: ContextEntry["summary"]) {
  if (summary === undefined) return [];
  return Object.entries(summary).map(([key, value]) => `${key}：${Array.isArray(value) ? value.join("、") : String(value)}`);
}

function EntryRows({ entries, selectedStepId, onSelect }: { entries: ContextEntry[]; selectedStepId?: string; onSelect(step: ContextStep): void }) {
  return <>{entries.map((entry) => <button className="file-row" type="button" key={entry.id} aria-pressed={selectedStepId === entry.step.id} aria-label={`${entry.label}，${entry.step.label}`} onClick={() => onSelect(entry.step)}>
    <span className={`file-type${entry.kind === "tool" ? " warning" : entry.kind === "reference" || entry.kind === "memory" ? " neutral" : ""}`}>
      {entry.kind === "attachment" ? <Paperclip /> : entry.kind === "reference" ? <Link2 /> : entry.kind === "memory" ? <Brain /> : entry.kind === "tool" ? <Hammer /> : entry.kind === "artifact" ? <PackageCheck /> : <FileText />}
    </span>
    <span><strong>{entry.label}</strong>{entry.detail === undefined ? null : <small>{entry.detail}</small>}{summaryLines(entry.summary).map((line) => <small key={line}>{line}</small>)}</span>
  </button>)}</>;
}

function EmptyContext() {
  return <div className="empty-panel"><FileText /><strong>当前会话没有上下文</strong><p>附件、引用文件、工具结果和任务产物会随对话步骤显示。</p></div>;
}

export function ContextTabs({ client, session, capabilities, activity }: ContextTabsProps) {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("上下文");
  const [snapshot, setSnapshot] = useState<ContextSnapshot>();
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [selectedStep, setSelectedStep] = useState<ContextStep>();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeId = tabIds[activeTab];
  const chatSupported = capabilities?.methods.has("chat.list") === true;
  const selectedEntries = useMemo(() => snapshot === undefined || selectedStep === undefined ? [] : [
    ...snapshot.attachments, ...snapshot.references, ...snapshot.memories, ...snapshot.tools, ...snapshot.artifacts,
  ].filter((entry) => entry.step.id === selectedStep.id), [selectedStep, snapshot]);

  useEffect(() => {
    if (session === undefined || !chatSupported) {
      setSnapshot(undefined);
      setSelectedStep(undefined);
      setState("idle");
      return;
    }
    let current = true;
    setSnapshot(undefined);
    setSelectedStep(undefined);
    setState("loading");
    void loadSnapshot(client, session.id).then((next) => {
      if (current && next.sessionId === session.id) setSnapshot(next);
      if (current && next.sessionId === session.id) setState("ready");
    }).catch(() => { if (current) setState("error"); });
    return () => { current = false; };
  }, [chatSupported, client, session?.id]);

  const activate = (index: number) => { setActiveTab(tabs[index]); tabRefs.current[index]?.focus(); };
  const selectStep = (step: ContextStep) => setSelectedStep(step);

  return <>
    <div className="context-tabs" role="tablist" aria-label="上下文类型">{tabs.map((tab, index) => <button
      ref={(node) => { tabRefs.current[index] = node; }} key={tab} id={`context-tab-${tabIds[tab]}`} type="button" role="tab"
      aria-controls={`context-panel-${tabIds[tab]}`} aria-selected={activeTab === tab} tabIndex={activeTab === tab ? 0 : -1}
      onClick={() => setActiveTab(tab)} onKeyDown={(event) => {
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
        if (next !== undefined) { event.preventDefault(); activate(next); }
      }}>{tab}</button>)}</div>
    <div className="context-content" id={`context-panel-${activeId}`} role="tabpanel" aria-labelledby={`context-tab-${activeId}`}>
      {activeTab === "上下文" ? <>{session === undefined ? <div className="empty-panel"><FileText /><strong>未选择会话</strong></div> : capabilities === undefined ? <div className="empty-panel"><FileText /><strong>正在检查上下文能力</strong></div> : !chatSupported ? <div className="empty-panel"><FileText /><strong>上下文不可用</strong><p>当前连接未提供会话历史读取能力。</p></div> : state === "loading" ? <div className="empty-panel"><FileText /><strong>正在加载会话上下文</strong></div> : state === "error" ? <div className="empty-panel"><FileText /><strong>上下文加载失败</strong></div> : snapshot === undefined || (snapshot.attachments.length + snapshot.references.length + snapshot.tools.length + snapshot.artifacts.length === 0) ? <EmptyContext /> : <>
        <p className="panel-label">附件</p><EntryRows entries={snapshot.attachments} selectedStepId={selectedStep?.id} onSelect={selectStep} />
        <p className="panel-label">引用文件</p><EntryRows entries={snapshot.references} selectedStepId={selectedStep?.id} onSelect={selectStep} />
        <p className="panel-label">工具结果</p><EntryRows entries={snapshot.tools} selectedStepId={selectedStep?.id} onSelect={selectStep} />
        <p className="panel-label">任务产物</p><EntryRows entries={snapshot.artifacts} selectedStepId={selectedStep?.id} onSelect={selectStep} />
      </>}</> : null}
      {activeTab === "记忆" ? snapshot === undefined ? <div className="empty-panel"><Brain /><strong>{state === "loading" ? "正在加载记忆上下文" : "记忆不可用"}</strong></div> : snapshot.memories.length === 0 ? <div className="empty-panel"><Brain /><strong>当前会话没有引用记忆</strong></div> : <><p className="panel-label">记忆</p><EntryRows entries={snapshot.memories} selectedStepId={selectedStep?.id} onSelect={selectStep} /></> : null}
      {activeTab === "活动" ? <div className="empty-panel"><Activity /><strong>{session?.title ?? "未选择会话"}</strong>{activity.length === 0 ? <p>此会话暂无活动。</p> : activity.map((item, index) => <p key={`${index}-${item}`}>{item}</p>)}</div> : null}
      {selectedStep === undefined || selectedEntries.length === 0 ? null : <div className="context-callout"><Activity /><span><strong>{selectedStep.label}</strong><small>当前选中步骤关联 {selectedEntries.length} 项上下文。</small></span></div>}
    </div>
    <footer><FileText /><span>上下文使用量</span><strong>{snapshot === undefined ? "加载中" : `${snapshot.attachments.length + snapshot.references.length + snapshot.memories.length + snapshot.tools.length + snapshot.artifacts.length} 项`}</strong></footer>
  </>;
}
