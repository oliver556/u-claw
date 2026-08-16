import type { Page } from "@playwright/test";
import type { ArtifactSnapshot, TaskActivitySnapshot } from "@uclaw/shared";

const activitySnapshot = {
  contractVersion: 1,
  generatedAt: "2026-08-08T08:00:00.000Z",
  source: "openclaw",
  tasks: [],
} satisfies TaskActivitySnapshot;

const artifactSnapshot = {
  contractVersion: 1,
  generatedAt: "2026-08-08T08:00:00.000Z",
  source: "openclaw",
  artifacts: [],
} satisfies ArtifactSnapshot;

export async function installBrowserTestBridge(page: Page): Promise<void> {
  await page.addInitScript(({ activitySnapshot, artifactSnapshot }) => {
    const existing = (window as any).uclaw ?? {};
    if (existing.client) return;

    const now = "2026-08-08T08:00:00.000Z";
    const listeners = new Set<(event: any) => void>();
    const statusSubscriptions = new Set<string>();
    const timers = new Map<string, number[]>();
    const runRequests = new Map<string, string>();
    let connected = true;
    let sessionSequence = 1;
    let runSequence = 0;
    let messageSequence = 1;
    const sessions: any[] = [{ id: "session-1", title: "Welcome", createdAt: now, updatedAt: now, pinned: false, status: "idle" }];
    const messages = new Map<string, any[]>([["session-1", [{
      id: "message-1", sessionId: "session-1", role: "assistant", status: "completed",
      blocks: [{ id: "block-1", type: "text", text: "Ready", format: "plain" }], createdAt: now,
    }]]]);
    const tools: any[] = [{
      id: "tool-call-1", sessionId: "session-1", runId: "run-pending", toolId: "exec",
      displayName: "Execute command", state: "waiting-authorization", risk: "high",
      inputSummary: { command: "echo fixture" },
    }];
    const approvals: any[] = [{
      id: "approval-exec-1", family: "exec", sessionId: "session-1", toolCallId: "tool-call-1",
      subject: { kind: "toolCall", id: "tool-call-1" }, title: "Run command",
      description: "Execute fixture command", risk: "high",
      permissions: [{ kind: "process", scope: "fixture", description: "Run fixture process" }],
      choices: ["allow-once", "deny"], status: "pending",
    }];
    const success = (request: any, result: unknown) => ({ method: request.method, requestId: request.requestId, ok: true, result });
    const status = () => ({
      connectionState: connected ? "ready" : "failed", protocolVersion: 4,
      phase: connected ? "available" : "failed", processAlive: connected,
      serviceReady: connected, businessAvailable: connected, since: now, attempt: 0,
      openClawVersion: "2026.7.1-2", usb: { state: "available", dataWritable: true, displayName: "U-Claw Data" },
    });
    const emitStatus = () => {
      for (const subscriptionId of statusSubscriptions) {
        for (const listener of listeners) listener({ event: "gateway.status", subscriptionId, payload: status() });
      }
    };
    const emitSend = (clientRequestId: string, payload: any) => {
      for (const listener of listeners) listener({ event: "chat.send-event", clientRequestId, payload });
    };
    const clearRun = (runId: string) => {
      for (const timer of timers.get(runId) ?? []) window.clearTimeout(timer);
      timers.delete(runId);
    };

    window.addEventListener("uclaw:mock-connection", ((event: CustomEvent<boolean>) => {
      connected = event.detail;
      emitStatus();
    }) as EventListener);

    const client = {
      subscribe(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async invoke(request: any) {
        const params = request.params ?? {};
        if (request.method === "gateway.negotiate") return success(request, {
          protocolVersion: 4,
          methods: ["sessions.list", "sessions.get", "sessions.create", "sessions.delete", "chat.history", "chat.send", "chat.abort", "tools.catalog", "session.tool.get", "exec.approval.list"],
          events: ["chat"], features: { attachments: false, approvalResolve: false },
        });
        if (request.method === "gateway.get-status") return success(request, status());
        if (request.method === "gateway.watch-status") {
          statusSubscriptions.add(params.subscriptionId);
          window.setTimeout(emitStatus, 0);
          return success(request, null);
        }
        if (request.method === "gateway.reconnect") { connected = true; emitStatus(); return success(request, null); }
        if (request.method === "subscriptions.cancel") { statusSubscriptions.delete(params.subscriptionId); return success(request, null); }
        if (request.method === "sessions.list") return success(request, { items: sessions, nextCursor: null, hasMore: false });
        if (request.method === "sessions.get") return success(request, sessions.find((item) => item.id === params.sessionId));
        if (request.method === "sessions.create") {
          const session = { id: `session-${++sessionSequence}`, title: params.title ?? "New session", createdAt: now, updatedAt: now, pinned: false, status: "idle" };
          sessions.push(session); messages.set(session.id, []); return success(request, session);
        }
        if (request.method === "sessions.rename") {
          const session = sessions.find((item) => item.id === params.sessionId); if (session) session.title = params.title;
          return success(request, session);
        }
        if (request.method === "sessions.remove") {
          const index = sessions.findIndex((item) => item.id === params.sessionId); if (index >= 0) sessions.splice(index, 1);
          messages.delete(params.sessionId); return success(request, null);
        }
        if ([
          "session-organizer.get",
          "session-organizer.set-pinned",
          "session-organizer.create-group",
          "session-organizer.rename-group",
          "session-organizer.assign-group",
        ].includes(request.method)) return success(request, { schemaVersion: 1, groups: [], sessions: [] });
        if (request.method === "chat.list") return success(request, { items: messages.get(params.sessionId) ?? [], nextCursor: null, hasMore: false });
        if (request.method === "chat.get") return success(request, (messages.get(params.sessionId) ?? []).find((item) => item.id === params.messageId));
        if (request.method === "chat.watch") return success(request, null);
        if (request.method === "approvals.list-pending") return success(request, approvals.filter((item) => item.status === "pending" && (!params.sessionId || item.sessionId === params.sessionId)));
        if (request.method === "tools.get-call") return success(request, tools.find((item) => item.id === params.toolCallId));
        if (request.method === "tools.list") return success(request, []);
        if (request.method === "chat.send") {
          const runId = `run-${++runSequence}`;
          runRequests.set(runId, params.clientRequestId);
          const text = (params.blocks ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
          const history = messages.get(params.sessionId) ?? [];
          history.push({ id: `message-${++messageSequence}`, sessionId: params.sessionId, role: "user", status: "completed", blocks: [{ id: `block-${messageSequence}`, type: "text", text, format: "plain" }], createdAt: now });
          messages.set(params.sessionId, history);
          const tool = { id: `tool-call-${runId}`, sessionId: params.sessionId, runId, toolId: "exec", displayName: "Inspect workspace", state: "waiting-authorization", risk: "high", inputSummary: { command: "fixture inspect" } };
          const approval = { id: `approval-${runId}`, family: "exec", sessionId: params.sessionId, toolCallId: tool.id, subject: { kind: "toolCall", id: tool.id }, title: "Inspect workspace", description: "Allow fixture workspace inspection", risk: "high", permissions: [{ kind: "file-read", scope: "fixture", description: "Read fixture workspace" }], choices: ["allow-once", "deny"], status: "pending" };
          const schedule = (delay: number, callback: () => void) => window.setTimeout(callback, delay);
          timers.set(runId, [
            schedule(0, () => emitSend(params.clientRequestId, { type: "started", runId, sessionId: params.sessionId })),
            schedule(120, () => emitSend(params.clientRequestId, { type: "delta", runId, mode: "append", text: "Fixture " })),
            schedule(180, () => { tools.push(tool); approvals.push(approval); emitSend(params.clientRequestId, { type: "tool", runId, tool }); emitSend(params.clientRequestId, { type: "approval", runId, approval }); }),
            schedule(260, () => {
              emitSend(params.clientRequestId, { type: "delta", runId, mode: "replace", text: "Fixture response" });
              const message = { id: `message-${++messageSequence}`, sessionId: params.sessionId, runId, role: "assistant", status: "completed", blocks: [{ id: `block-${messageSequence}`, type: "text", text: "Fixture response", format: "plain" }], createdAt: now };
              history.push(message);
              const session = sessions.find((item) => item.id === params.sessionId); if (session) { session.title = text.slice(0, 48) || session.title; session.lastMessagePreview = "Fixture response"; }
              emitSend(params.clientRequestId, { type: "final", runId, message }); clearRun(runId);
            }),
          ]);
          return success(request, { clientRequestId: params.clientRequestId, runId });
        }
        if (request.method === "chat.abort") {
          clearRun(params.runId);
          const clientRequestId = runRequests.get(params.runId);
          for (const listener of listeners) listener({ event: "chat.send-event", clientRequestId, payload: { type: "aborted", runId: params.runId, reason: "Cancelled" } });
          return success(request, null);
        }
        if (request.method === "chat.cancel-stream") return success(request, null);
        if (request.method === "models.list") return success(request, []);
        if (request.method === "models.select-for-session") return success(request, null);
        if (request.method === "activity.list") return success(request, activitySnapshot);
        if (request.method === "artifacts.list") return success(request, artifactSnapshot);
        throw new Error(`Unexpected browser test IPC method: ${request.method}`);
      },
    };
    const data = existing.data ?? { invoke: async (request: any) => {
      if (request.method === "data.status") return success(request, { state: "available", writable: true });
      if (request.method === "workspace.list" || request.method === "memory.list") return success(request, { items: [], nextCursor: null, hasMore: false });
      throw new Error(`Unexpected browser test data method: ${request.method}`);
    } };
    const skills = existing.skills ?? { invoke: async (request: any) => {
      if (request.method === "skills.installed") return success(request, []);
      if (request.method === "skills.runtime-status") return success(request, { workspaceDir: "", managedSkillsDir: "", skills: [] });
      throw new Error(`Unexpected browser test skill method: ${request.method}`);
    } };
    const taskArtifacts = existing.taskArtifacts ?? {
      subscribe() { return () => undefined; },
      async invoke(request: any) {
        if (request.method === "tasks.list" || request.method === "artifacts.list") return success(request, []);
        throw new Error(`Unexpected browser test Task/Artifact method: ${request.method}`);
      },
    };
    Object.defineProperty(window, "uclaw", { configurable: true, writable: true, value: { ...existing, client, data, skills, taskArtifacts } });
  }, { activitySnapshot, artifactSnapshot });
}
