import {
  ActivityDomainIdSchema,
  ArtifactSnapshotSchema,
  TaskActivitySnapshotSchema,
  type ArtifactStatus,
  type Message,
  type Page,
  type SessionSummary,
  type TaskActivity,
  type TaskActivityState,
  type UClawClient,
} from "@uclaw/shared";

async function listAll<T>(load: (cursor?: string) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await load(cursor);
    items.push(...page.items);
    if (!page.hasMore || page.nextCursor === null || seen.has(page.nextCursor)) return items;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

function taskState(message: Message): TaskActivityState {
  if (message.status === "completed") return "succeeded";
  if (message.status === "failed") return "failed";
  if (message.status === "cancelled") return "cancelled";
  if (message.status === "waiting-authorization") return "waiting-input";
  return "running";
}

function artifactStatus(message: Message): ArtifactStatus {
  if (message.status === "completed") return "ready";
  if (message.status === "failed") return "failed";
  if (message.status === "cancelled") return "cancelled";
  return "pending";
}

function fallbackTask(session: SessionSummary): TaskActivity | undefined {
  if (session.status === "idle") return undefined;
  const state = session.status === "running"
    ? "running"
    : session.status === "waiting-authorization" ? "waiting-input" : "failed";
  return {
    id: `session:${session.id}`,
    sessionId: session.id,
    sessionTitle: session.title,
    title: session.title || "OpenClaw task",
    state,
    updatedAt: session.updatedAt,
    ...(state === "failed" ? { error: { code: "OPERATION_FAILED" as const, message: "Task failed.", retryable: true } } : {}),
  };
}

export async function buildTaskCenterSnapshot(
  client: UClawClient,
  now: () => string = () => new Date().toISOString(),
  artifactSessionId?: string,
) {
  if (artifactSessionId !== undefined) ActivityDomainIdSchema.parse(artifactSessionId);
  const [sessions, approvals] = await Promise.all([
    listAll((cursor) => client.sessions.list(cursor === undefined ? {} : { cursor })),
    client.approvals.listPending().catch(() => []),
  ]);
  const sessionsWaitingForInput = new Set(approvals.flatMap((approval) => approval.sessionId === undefined ? [] : [approval.sessionId]));
  const rows = await Promise.all(sessions.map(async (session) => ({
    session,
    messages: await listAll((cursor) => client.chat.list(session.id, cursor === undefined ? {} : { cursor })),
  })));
  const tasks: TaskActivity[] = [];
  const artifacts = [];

  for (const { session, messages } of rows) {
    let hasLiveMessage = false;
    for (const message of messages) {
      if (message.role === "assistant" && message.runId !== undefined) {
        const rawState = taskState(message);
        const state = rawState === "running" && sessionsWaitingForInput.has(session.id) ? "waiting-input" : rawState;
        if (state === "running" || state === "waiting-input") hasLiveMessage = true;
        tasks.push({
          id: `run:${message.runId}`,
          sessionId: session.id,
          sessionTitle: session.title,
          runId: message.runId,
          title: session.title || "OpenClaw task",
          state,
          updatedAt: message.updatedAt ?? message.createdAt,
          ...(state === "failed" ? { error: { code: message.error?.code ?? "OPERATION_FAILED", message: "Task failed.", retryable: message.error?.retryable ?? true } } : {}),
        });
      }
      if (artifactSessionId !== undefined && artifactSessionId !== session.id) continue;
      for (const block of message.blocks) {
        if ((block.type !== "file" && block.type !== "image") || block.file.kind !== "artifact") continue;
        artifacts.push({
          id: block.file.id,
          sessionId: session.id,
          messageId: message.id,
          ...(message.runId === undefined ? {} : { runId: message.runId }),
          name: block.file.name,
          mediaType: block.file.mediaType,
          size: block.file.size,
          createdAt: message.updatedAt ?? message.createdAt,
          status: artifactStatus(message),
        });
      }
    }
    if (!hasLiveMessage) {
      const fallback = fallbackTask(session);
      if (fallback !== undefined && !tasks.some((task) => task.sessionId === session.id && task.state === fallback.state)) tasks.push(fallback);
    }
  }

  tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  artifacts.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const generatedAt = now();
  return {
    activity: TaskActivitySnapshotSchema.parse({ contractVersion: 1, generatedAt, source: "openclaw", tasks }),
    artifacts: ArtifactSnapshotSchema.parse({ contractVersion: 1, generatedAt, source: "openclaw", artifacts }),
  };
}
