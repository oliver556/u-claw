import { parseSkillInstallIntent, type ApprovalDecision, type ApprovalRequest, type Attachment, type CapabilitySet, type ChatQueueDocument, type ChatQueueItem, type GatewayStatus, type Message, type MessageEvent, type Session, type SkillCatalogItem, type SkillRuntimeInventory, type ToolCall, type UClawClient } from "@uclaw/shared";
import { AlertCircle, LoaderCircle, RotateCw, WifiOff, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { QueuedMessageBar } from "./QueuedMessageBar";
import { toProductModels } from "./product-model-catalog";
import { useMessageStream } from "./useMessageStream";

interface ConversationProps {
  client: UClawClient;
  session: Session;
  capabilities?: CapabilitySet;
  gatewayStatus?: GatewayStatus;
  draft: string;
  onDraftChange(value: string): void;
  onActivity(message: string): void;
  onSendSuccess(sessionId: string): void;
  onSessionUpdated(sessionId: string): void;
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function resolveApproval(client: Pick<UClawClient, "approvals">, approval: ApprovalRequest, decision: ApprovalDecision) {
  if (approval.family === "exec") return client.approvals.resolveExec({ ref: { family: "exec", id: approval.id }, decision });
  return client.approvals.resolvePlugin({ ref: { family: "plugin", id: approval.id }, decision });
}

export function Conversation({ client, session, capabilities, gatewayStatus, draft, onDraftChange, onActivity, onSendSuccess, onSessionUpdated }: ConversationProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("loading");
  const [historyError, setHistoryError] = useState<string>();
  const [historyNextCursor, setHistoryNextCursor] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyPageState, setHistoryPageState] = useState<"idle" | "loading" | "error">("idle");
  const [historyPageError, setHistoryPageError] = useState<string>();
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [pendingTools, setPendingTools] = useState<ToolCall[]>([]);
  const [sending, setSending] = useState(false);
  const activeSends = useRef(0);
  const [sendError, setSendError] = useState<string>();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [queueItems, setQueueItems] = useState<ChatQueueItem[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  const [models, setModels] = useState<Array<{ id: string; label: string; available: boolean }>>([]);
  const [modelState, setModelState] = useState<"idle" | "loading" | "error" | "selecting">("idle");
  const [skills, setSkills] = useState<Array<{ id: string; name: string }>>([]);
  const [skillState, setSkillState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedSkillId, setSelectedSkillId] = useState<string>();
  const [installedSkillName, setInstalledSkillName] = useState<string>();
  const activeRunId = useRef<string | undefined>(undefined);
  const sendController = useRef<AbortController | undefined>(undefined);
  const stopRequested = useRef(false);
  const sendIntentId = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const resolvingApprovals = useRef(new Set<string>());
  const defaultModelSelections = useRef(new Set<string>());
  const conversationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sendController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!installedSkillName) return;
    const timeout = window.setTimeout(() => setInstalledSkillName(undefined), 8_000);
    return () => window.clearTimeout(timeout);
  }, [installedSkillName]);

  const onStreamEvent = useCallback((event: MessageEvent) => {
    if (!mounted.current) return;
    if (event.type === "started") {
      activeRunId.current = event.runId;
      onActivity("响应已开始");
      if (stopRequested.current) void client.chat.abort(event.runId).catch(() => undefined);
    } else if (event.type === "tool") onActivity(`工具：${event.tool.displayName}`);
    else if (event.type === "approval") onActivity(`等待授权：${event.approval.title}`);
    else if (event.type === "final") {
      setMessages((current) => current.some((message) => message.id === event.message.id)
        ? current
        : [...current, event.message]);
      onActivity("响应已完成");
    }
    else if (event.type === "aborted") onActivity("响应已停止");
    else if (event.type === "error") onActivity(`响应失败：${event.error.message}`);
  }, [client, onActivity]);
  const { state: stream, consume, dismissApproval } = useMessageStream(onStreamEvent);

  useEffect(() => {
    const element = conversationRef.current;
    if (element === null) return;
    if (typeof element.scrollTo === "function") element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    else element.scrollTop = element.scrollHeight;
  }, [messages, stream, sending, sendError]);

  const loadHistory = useCallback(async () => {
    setHistoryState("loading");
    setHistoryError(undefined);
    try {
      const [history, approvals] = await Promise.all([
        client.chat.list(session.id),
        client.approvals.listPending(session.id).catch(() => []),
      ]);
      const tools = await Promise.all(approvals.flatMap((approval) => approval.family === "exec" && approval.toolCallId !== undefined
        ? [client.tools.getCall(approval.toolCallId).catch(() => undefined)]
        : []));
      setMessages(history.items);
      setHistoryNextCursor(history.nextCursor ?? null);
      setHistoryHasMore(history.hasMore);
      setHistoryPageState("idle");
      setHistoryPageError(undefined);
      setPendingApprovals(approvals);
      setPendingTools(tools.filter((tool): tool is ToolCall => tool !== undefined));
      setHistoryState("ready");
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "消息加载失败");
      setHistoryState("error");
    }
  }, [client, session.id]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const loadMoreHistory = async () => {
    if (!historyHasMore || historyNextCursor === null || historyPageState === "loading") return;
    setHistoryPageState("loading");
    setHistoryPageError(undefined);
    try {
      const page = await client.chat.list(session.id, { cursor: historyNextCursor });
      setMessages((current) => {
        const known = new Set(current.map((message) => message.id));
        return [...current, ...page.items.filter((message) => !known.has(message.id))];
      });
      setHistoryNextCursor(page.nextCursor ?? null);
      setHistoryHasMore(page.hasMore);
      setHistoryPageState("idle");
    } catch (error) {
      setHistoryPageError(error instanceof Error ? error.message : "加载更多消息失败");
      setHistoryPageState("error");
    }
  };

  useEffect(() => {
    if (capabilities?.methods.has("models.list") !== true) return;
    let active = true;
    setModelState("loading");
    void client.models.list().then(async (items) => {
      if (!active) return;
      const productModels = toProductModels(items);
      setModels(productModels);
      const target = productModels.find((model) => model.available);
      const currentModelAllowed = productModels.some((model) => model.id === session.model?.id);
      const selectionKey = target === undefined ? undefined : `${session.id}\0${target.id}`;
      if (target !== undefined && !currentModelAllowed && selectionKey !== undefined && !defaultModelSelections.current.has(selectionKey)) {
        defaultModelSelections.current.add(selectionKey);
        await client.models.selectForSession(session.id, target.id);
        if (active) onSessionUpdated(session.id);
      }
      setModelState("idle");
    }).catch(() => { if (active) setModelState("error"); });
    return () => { active = false; };
  }, [capabilities, client, onSessionUpdated, session.id, session.model?.id]);

  useEffect(() => {
    const invoke = window.uclaw?.skills?.invoke;
    if (invoke === undefined) { setSkillState("error"); return; }
    let active = true;
    setSkillState("loading");
    void Promise.all([
      invoke({ method: "skills.runtime-status", requestId: requestId(), params: {} }),
      invoke({ method: "skills.installed", requestId: requestId(), params: {} }),
    ]).then(([runtimeResponse, installedResponse]: any[]) => {
      if (!active) return;
      if (!runtimeResponse.ok) throw new Error(runtimeResponse.error.message);
      const inventory = runtimeResponse.result as SkillRuntimeInventory;
      const installed = installedResponse.ok && Array.isArray(installedResponse.result) ? installedResponse.result as SkillCatalogItem[] : [];
      const installedBySlug = new Map(installed.map((skill) => [skill.slug, skill]));
      setSkills(inventory.skills.filter((skill) => !skill.disabled && skill.availability === "available" && skill.eligible && skill.userInvocable && skill.commandVisible)
        .map((skill) => ({ id: skill.runtimeId ?? skill.id, name: installedBySlug.get(skill.id)?.name ?? skill.name })));
      setSkillState("ready");
    }).catch(() => { if (active) setSkillState("error"); });
    return () => { active = false; };
  }, [session.id]);

  const unavailable = gatewayStatus !== undefined && !gatewayStatus.businessAvailable;
  const attachmentsSupported = capabilities?.features.attachments === true;
  const legacyApprovalResolve = capabilities?.features.approvalResolve === true && capabilities?.features.execApproval === undefined && capabilities?.features.pluginApproval === undefined;
  const approvalCapabilities = { exec: capabilities?.features.execApproval === true || legacyApprovalResolve, plugin: capabilities?.features.pluginApproval === true || legacyApprovalResolve };

  const attachmentInvoke = async (method: "select" | "import" | "get" | "prepare" | "remove", params: object) => {
    const invoke = window.uclaw?.attachments?.invoke;
    if (invoke === undefined) throw new Error("附件服务不可用");
    const response = await invoke({ method, requestId: requestId(), params } as never);
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  };

  const queueInvoke = async (method: "chat-queue.list" | "chat-queue.add" | "chat-queue.update" | "chat-queue.remove" | "chat-queue.send", params: any) => {
    const invoke = window.uclaw?.chatQueue?.invoke;
    if (invoke === undefined) throw new Error("消息队列服务不可用");
    const response = await invoke({ method, requestId: requestId(), params } as never);
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  };

  const refreshQueue = useCallback(async () => {
    const invoke = window.uclaw?.chatQueue?.invoke;
    if (invoke === undefined) { setQueueItems([]); return; }
    try {
      const response = await invoke({ method: "chat-queue.list", requestId: requestId(), params: { sessionId: session.id } });
      if (!response.ok) throw new Error(response.error.message);
      setQueueItems((response.result as ChatQueueDocument).items);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "队列加载失败");
    }
  }, [session.id]);

  useEffect(() => {
    void refreshQueue();
    const timer = window.setInterval(() => void refreshQueue(), 2_000);
    return () => window.clearInterval(timer);
  }, [refreshQueue]);

  const invalidateSendIntent = () => { sendIntentId.current = undefined; };
  const updateAttachments = (update: (current: Attachment[]) => Attachment[]) => {
    const next = update(attachmentsRef.current);
    attachmentsRef.current = next;
    setAttachments(next);
    return next;
  };

  const prepareAttachment = async (id: string) => {
    updateAttachments((current) => current.map((item) => item.id === id ? { ...item, state: "validating" } : item));
    try {
      const states = await attachmentInvoke("prepare", { attachmentId: id }) as Attachment[];
      const latest = states.at(-1);
      if (latest) updateAttachments((current) => current.map((item) => item.id === id ? latest : item));
    } catch (error) {
      updateAttachments((current) => current.map((item) => item.id === id ? { ...item, state: "failed", error: { code: "OPERATION_FAILED", message: error instanceof Error ? error.message : "附件处理失败", retryable: true } } : item));
    }
  };

  const addAttachmentInputs = async (inputs: Array<{ name: string; mediaType: string; size: number; contentBase64: string }>) => {
    for (const input of inputs) {
      try {
        const attachment = await attachmentInvoke("import", input) as Attachment;
        if (!attachmentsRef.current.some((item) => item.id === attachment.id)) invalidateSendIntent();
        updateAttachments((current) => [...current.filter((item) => item.id !== attachment.id), attachment]);
        void prepareAttachment(attachment.id);
      } catch (error) {
        setSendError(error instanceof Error ? error.message : "添加附件失败");
      }
    }
  };

  const selectAttachments = async () => {
    try {
      const selected = await attachmentInvoke("select", {}) as Attachment[];
      const knownIds = new Set(attachmentsRef.current.map((attachment) => attachment.id));
      const additions = selected.filter((attachment) => {
        if (knownIds.has(attachment.id)) return false;
        knownIds.add(attachment.id);
        return true;
      });
      if (additions.length > 0) invalidateSendIntent();
      updateAttachments((current) => [...current, ...additions]);
      additions.forEach((attachment) => void prepareAttachment(attachment.id));
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "选择附件失败");
    }
  };

  const dropFiles = async (files: File[]) => {
    if (files.length === 0) return;
    try {
      const inputs = await Promise.all(files.map(async (file) => {
        const contentBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("读取附件失败"));
          reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
          reader.readAsDataURL(file);
        });
        return { name: file.name, mediaType: file.type || "application/octet-stream", size: file.size, contentBase64 };
      }));
      await addAttachmentInputs(inputs);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "添加附件失败");
    }
  };

  const refreshAttachmentStates = async (sent: Attachment[]) => {
    if (sent.length === 0) return;
    const refreshed = await Promise.all(sent.map(async (attachment) => {
      try { return await attachmentInvoke("get", { attachmentId: attachment.id }) as Attachment; }
      catch { return { ...attachment, state: "failed" as const, error: { code: "OPERATION_FAILED" as const, message: "附件发送失败", retryable: true } }; }
    }));
    updateAttachments((current) => current.map((attachment) => refreshed.find((item) => item.id === attachment.id) ?? attachment));
  };

  const send = async () => {
    const text = draft.trim();
    const installIntent = parseSkillInstallIntent(text);
    const readyAttachments = attachments.filter((attachment) => attachment.state === "ready");
    if ((text.length === 0 && readyAttachments.length === 0) || attachments.some((attachment) => attachment.state !== "ready") || unavailable) return;
    setSendError(undefined);
    activeSends.current += 1;
    setSending(true);
    onDraftChange("");
    stopRequested.current = false;
    const controller = new AbortController();
    sendController.current = controller;
    onActivity("消息已发送");
    const optimistic: Message = {
      id: `local-${requestId()}`, sessionId: session.id, role: "user", status: "completed",
      blocks: text === "" ? [] : [{ id: `local-block-${requestId()}`, type: "text", text, format: "plain" }],
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    if (installIntent) setInstalledSkillName(undefined);
    const readBackSkillInstall = async () => {
      if (!installIntent) return false;
      const invoke = window.uclaw?.skills?.invoke;
      if (!invoke) return false;
      const response: any = await invoke({ method: "skills.installed", requestId: requestId(), params: {} });
      if (!response.ok) return false;
      const expectedSlug = installIntent.identity.slice(installIntent.identity.indexOf("/") + 1);
      const installed = (response.result as Array<{ slug: string; name: string }>).find((item) => item.slug === expectedSlug);
      if (!installed) return false;
      setInstalledSkillName(installed.name);
      return true;
    };
    const markSendFailed = (message: string) => {
      setMessages((current) => current.map((item) => item.id === optimistic.id ? {
        ...item,
        status: "failed",
        error: { code: "OPERATION_FAILED", message, retryable: true },
      } : item));
      setSendError(message);
    };
    try {
      const blocks = [...(text === "" ? [] : [{ type: "text" as const, text, format: "plain" as const }]), ...readyAttachments.map((attachment) => ({ type: "attachment" as const, attachmentId: attachment.id }))];
      const clientRequestId = sendIntentId.current ??= requestId();
      const terminal = await consume(client.chat.send({ sessionId: session.id, clientRequestId, blocks, ...(selectedSkillId === undefined ? {} : { skillId: selectedSkillId }) }, controller.signal));
      if (!mounted.current) return;
      if (terminal?.type === "error") {
        const installed = await readBackSkillInstall().catch(() => false);
        if (!installed) {
          markSendFailed(terminal.error.message);
          await refreshAttachmentStates(readyAttachments);
        }
      }
      else if (terminal?.type === "aborted") {
        onDraftChange(text);
        sendIntentId.current = undefined;
      }
      else if (terminal?.type === "final") {
        setSelectedSkillId(undefined);
        const sentIds = new Set(readyAttachments.map((attachment) => attachment.id));
        updateAttachments((current) => current.filter((attachment) => !sentIds.has(attachment.id)));
        await Promise.all(readyAttachments.map((attachment) => attachmentInvoke("remove", { attachmentId: attachment.id }).catch(() => undefined)));
        sendIntentId.current = undefined;
        await readBackSkillInstall().catch(() => false);
        onSendSuccess(session.id);
      }
    } catch (error) {
      if (mounted.current && !stopRequested.current) {
        markSendFailed(error instanceof Error ? error.message : "发送失败");
        await refreshAttachmentStates(readyAttachments);
      }
    } finally {
      activeRunId.current = undefined;
      sendController.current = undefined;
      stopRequested.current = false;
      activeSends.current = Math.max(0, activeSends.current - 1);
      if (mounted.current) setSending(activeSends.current > 0);
    }
  };

  const addToQueue = async () => {
    const text = draft.trim();
    const readyAttachments = attachments.filter((attachment) => attachment.state === "ready");
    if ((text.length === 0 && readyAttachments.length === 0) || attachments.some((attachment) => attachment.state !== "ready") || unavailable) return;
    try {
      await queueInvoke("chat-queue.add", {
        sessionId: session.id,
        text,
        attachmentIds: readyAttachments.map((attachment) => attachment.id),
        ...(session.model?.id === undefined ? {} : { modelId: session.model.id }),
        ...(selectedSkillId === undefined ? {} : { skillId: selectedSkillId }),
        idempotencyKey: requestId(),
      });
      onDraftChange("");
      updateAttachments(() => []);
      setSelectedSkillId(undefined);
      await refreshQueue();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "加入队列失败");
    }
  };

  const stop = async () => {
    stopRequested.current = true;
    const runId = activeRunId.current;
    if (runId === undefined) return;
    try { await client.chat.abort(runId); }
    catch (error) { setSendError(error instanceof Error ? error.message : "停止失败"); }
  };

  const handleApproval = async (approval: ApprovalRequest, decision: ApprovalDecision) => {
    if (resolvingApprovals.current.has(approval.id)) return;
    resolvingApprovals.current.add(approval.id);
    try {
      await resolveApproval(client, approval, decision);
      setPendingApprovals((current) => current.filter((item) => item.id !== approval.id));
      dismissApproval(approval.id);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "授权处理失败");
      throw error;
    } finally {
      resolvingApprovals.current.delete(approval.id);
    }
  };

  const selectModel = async (modelId: string) => {
    setModelState("selecting");
    try {
      await client.models.selectForSession(session.id, modelId);
      onSessionUpdated(session.id);
      setModelState("idle");
    } catch (error) {
      setModelState("error");
      setSendError(error instanceof Error ? error.message : "切换模型失败");
    }
  };

  return <section className="work-canvas">
    {unavailable ? <div className="connection-alert" role="alert"><WifiOff /><span><strong>服务连接已断开</strong><small>消息暂时无法发送，草稿仍保留在本机。</small></span><button type="button" onClick={() => void client.gateway.reconnect()}><RotateCw />重新连接</button></div> : null}
    <div className="conversation" ref={conversationRef} aria-busy={historyState === "loading"}>
      {historyState === "loading" ? <div className="conversation-state"><LoaderCircle className="spin" /><span>正在加载消息</span></div> : null}
      {historyState === "error" ? <div className="conversation-state" role="alert"><AlertCircle /><strong>消息加载失败</strong><span>{historyError}</span><button type="button" onClick={() => void loadHistory()}><RotateCw />重试</button></div> : null}
      {historyState === "ready" ? <><MessageList messages={messages} stream={stream} awaitingResponse={sending} pendingApprovals={pendingApprovals} pendingTools={pendingTools} canResolveApprovals={false} approvalCapabilities={approvalCapabilities} onResolveApproval={handleApproval} />
        {historyHasMore ? <button className="history-load-more" type="button" disabled={historyPageState === "loading"} onClick={() => void loadMoreHistory()}>{historyPageState === "loading" ? <LoaderCircle className="spin" /> : <RotateCw />}加载更多消息</button> : null}
        {historyPageState === "error" ? <div className="history-page-error" role="alert"><span>{historyPageError}</span><button type="button" onClick={() => void loadMoreHistory()}><RotateCw />重试加载</button></div> : null}</> : null}
    </div>
    {sendError ? <div className="send-error" role="alert"><AlertCircle /><span><strong>发送失败</strong>{sendError}</span></div> : null}
    {installedSkillName ? <div className="skill-install-status success" role="status"><span>{installedSkillName} 安装成功，OpenClaw 已完成读回。</span><button type="button" aria-label="关闭安装成功提示" title="关闭" onClick={() => setInstalledSkillName(undefined)}><X /></button></div> : null}
    <QueuedMessageBar items={queueItems} onSend={(item) => { void queueInvoke("chat-queue.send", { sessionId: session.id, itemId: item.id }).then(refreshQueue).catch((error) => setSendError(error instanceof Error ? error.message : "发送队列消息失败")); }} onRemove={(item) => { void queueInvoke("chat-queue.remove", { sessionId: session.id, itemId: item.id }).then(refreshQueue).catch((error) => setSendError(error instanceof Error ? error.message : "删除队列消息失败")); }} onSave={(item, text) => { void queueInvoke("chat-queue.update", { sessionId: session.id, itemId: item.id, text }).then(refreshQueue).catch((error) => setSendError(error instanceof Error ? error.message : "编辑队列消息失败")); }} />
    <Composer value={draft} disabled={unavailable || historyState !== "ready"} sending={sending} attachmentsSupported={attachmentsSupported} attachments={attachments} models={models.map((model) => ({ value: model.id, label: model.available ? model.label : `${model.label}（不可用）`, disabled: !model.available }))} modelValue={session.model?.id} modelLoading={modelState === "loading" || modelState === "selecting"} modelError={modelState === "error"} skills={skills.map((skill) => ({ value: skill.id, label: skill.name }))} skillValue={selectedSkillId} skillLoading={skillState === "loading"} onModelChange={(value) => void selectModel(value)} onSkillChange={(value) => { invalidateSendIntent(); setSelectedSkillId(value); }} onChange={(value) => { invalidateSendIntent(); onDraftChange(value); }} onSelectAttachments={() => void selectAttachments()} onDropFiles={(files) => void dropFiles(files)} onPrepareAttachment={(id) => { void prepareAttachment(id); }} onRemoveAttachment={(id) => { invalidateSendIntent(); void attachmentInvoke("remove", { attachmentId: id }).catch(() => undefined); updateAttachments((current) => current.filter((attachment) => attachment.id !== id)); }} onSend={() => void send()} onQueue={() => void addToQueue()} onStop={() => void stop()} />
  </section>;
}
