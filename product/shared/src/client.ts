import type { Page, PageRequest } from "./common.js";
import type { CreateSessionInput, Message, MessageEvent, SendMessageInput, Session, SessionListRequest, SessionSummary } from "./chat.js";
import type { CapabilitySet, GatewayStatus } from "./gateway.js";
import type {
  ChannelSummary,
  DiagnosticSummary,
  FileSummary,
  LogSummary,
  ModelSummary,
  SkillSummary,
  ToolSummary,
} from "./management.js";
import type {
  ApprovalRequest,
  ResolveExecApprovalInput,
  ResolvePluginApprovalInput,
  ToolCall,
} from "./tools.js";

export interface GatewayService {
  negotiate(): Promise<CapabilitySet>;
  getStatus(): Promise<GatewayStatus>;
  watchStatus(signal?: AbortSignal): AsyncIterable<GatewayStatus>;
  reconnect(): Promise<void>;
}

export interface SessionService {
  list(page?: SessionListRequest): Promise<Page<SessionSummary>>;
  get(sessionId: string): Promise<Session>;
  create(input?: CreateSessionInput): Promise<Session>;
  rename?(sessionId: string, title: string, revision?: string): Promise<Session>;
  remove(sessionId: string, revision?: string): Promise<void>;
}

export interface ChatService {
  list(sessionId: string, page?: PageRequest): Promise<Page<Message>>;
  get(sessionId: string, messageId: string): Promise<Message>;
  watch(sessionId: string, signal?: AbortSignal): AsyncIterable<MessageEvent>;
  send(input: SendMessageInput, signal?: AbortSignal): AsyncIterable<MessageEvent>;
  abort(runId: string): Promise<void>;
}

export interface ToolService {
  list(): Promise<ToolSummary[]>;
  getCall(toolCallId: string): Promise<ToolCall>;
}

export interface ApprovalService {
  listPending(sessionId?: string): Promise<ApprovalRequest[]>;
  resolveExec(input: ResolveExecApprovalInput): Promise<void>;
  resolvePlugin(input: ResolvePluginApprovalInput): Promise<void>;
}

export interface ModelService {
  list(): Promise<ModelSummary[]>;
  selectForSession(sessionId: string, modelId: string): Promise<void>;
}

export interface SkillService {
  list(): Promise<SkillSummary[]>;
}

export interface ChannelService {
  list(): Promise<ChannelSummary[]>;
}

export interface FileService {
  list(parentId?: string, page?: PageRequest): Promise<Page<FileSummary>>;
  readText(fileId: string): Promise<{ file: FileSummary; content: string; encoding: "utf-8" }>;
}

export interface DiagnosticsService {
  list(): Promise<DiagnosticSummary[]>;
  listLogs(page?: PageRequest): Promise<Page<LogSummary>>;
}

export interface UClawClient {
  gateway: GatewayService;
  sessions: SessionService;
  chat: ChatService;
  tools: ToolService;
  approvals: ApprovalService;
  models: ModelService;
  skills: SkillService;
  channels: ChannelService;
  files: FileService;
  diagnostics: DiagnosticsService;
}
