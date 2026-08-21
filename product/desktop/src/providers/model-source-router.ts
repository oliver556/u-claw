import { createHash } from "node:crypto";

import {
  BuiltinModelRequestSchema,
  MessageEventSchema,
  UClawErrorSchema,
  type BuiltinModelRequest,
  type BuiltinModelResponse,
  type MessageEvent,
  type ProviderConfigEntry,
  type ProviderNetworkSettings,
  type SendMessageInput,
  type UClawErrorCode,
} from "@uclaw/shared";

import {
  createBuiltinCredentialStore,
  type BuiltinCredentialStore,
  type BuiltinModelCredential,
} from "./builtin-credential-store.js";
import {
  BuiltinServiceClientError,
  createRemovedBuiltinServiceClient,
  type BuiltinServiceClient,
} from "./builtin-service-client.js";
import type { ProviderStore } from "./provider-store.js";

export type ModelSource = "builtin" | "domestic" | "custom";
export type ModelSourceFailureCategory = "authentication" | "quota" | "rate-limit" | "network" | "configuration" | "upstream";

const FAILURE_DETAILS: Record<ModelSourceFailureCategory, { code: UClawErrorCode; message: string; retryable: boolean }> = {
  authentication: { code: "PROVIDER_AUTH_FAILED", message: "Model provider authentication failed.", retryable: false },
  quota: { code: "MODEL_UNAVAILABLE", message: "Model provider quota is exhausted.", retryable: false },
  "rate-limit": { code: "NETWORK_UNREACHABLE", message: "Model provider rate limit was reached.", retryable: true },
  network: { code: "NETWORK_UNREACHABLE", message: "Model provider network request failed.", retryable: true },
  configuration: { code: "UNAVAILABLE", message: "Builtin model service is unavailable.", retryable: false },
  upstream: { code: "OPERATION_FAILED", message: "Model provider request failed.", retryable: false },
};

export class ModelSourceFailure extends Error {
  readonly code: UClawErrorCode;
  readonly retryable: boolean;
  readonly recoveryActions: ["retry"] | [];
  readonly causeDetails = {};

  constructor(readonly source: ModelSource, readonly category: ModelSourceFailureCategory) {
    const detail = FAILURE_DETAILS[category];
    super(detail.message);
    this.name = "ModelSourceFailure";
    this.code = detail.code;
    this.retryable = detail.retryable;
    this.recoveryActions = detail.retryable ? ["retry"] : [];
  }
}

export interface ModelSourceExecutors<Request, Result> {
  builtin(request: Request, credential: BuiltinModelCredential, signal?: AbortSignal): Promise<Result>;
  domestic(request: Request, provider: ProviderConfigEntry, signal?: AbortSignal, network?: ProviderNetworkSettings): Promise<Result>;
  custom(request: Request, provider: ProviderConfigEntry, signal?: AbortSignal, network?: ProviderNetworkSettings): Promise<Result>;
}

export type ExternalModelSourceExecutors<Request, Result> = Pick<
  ModelSourceExecutors<Request, Result>,
  "domestic" | "custom"
>;

export interface CreateModelSourceRouterOptions<Request, Result> {
  providers: ProviderStore;
  credentials: BuiltinCredentialStore;
  executors: ModelSourceExecutors<Request, Result>;
}

export interface CreateMainProcessModelRoutingOptions {
  dataDir: string;
  platformForTest?: NodeJS.Platform;
  allowUnpinnedFilesystemForTest?: true;
  providers: ProviderStore;
  executors: ExternalModelSourceExecutors<SendMessageInput, AsyncIterable<MessageEvent>>;
  allowLoopbackHttp?: boolean;
  legacyBuiltinClient?: BuiltinServiceClient;
}

const BUILTIN_MAX_OUTPUT_TOKENS = 4_096;
const BUILTIN_VALIDATION_MESSAGE = "Builtin service request was rejected.";

function builtinChatDigest(input: SendMessageInput): string {
  return createHash("sha256")
    .update("uclaw-builtin-chat-v1\0")
    .update(input.sessionId)
    .update("\0")
    .update(input.clientRequestId)
    .digest("hex");
}

function invalidBuiltinChatInput(): BuiltinServiceClientError {
  return new BuiltinServiceClientError("validation", "INVALID_REQUEST", BUILTIN_VALIDATION_MESSAGE, false);
}

function toBuiltinModelRequest(input: SendMessageInput, credential: BuiltinModelCredential): BuiltinModelRequest {
  const textBlocks = input.blocks.filter((block) => block.type === "text");
  if (textBlocks.length !== input.blocks.length || textBlocks.every((block) => block.text.length === 0)) {
    throw invalidBuiltinChatInput();
  }
  const prompt = textBlocks.map((block) => block.text).join("\n\n");
  const parsed = BuiltinModelRequestSchema.safeParse({
    schemaVersion: 1,
    requestId: `req_${builtinChatDigest(input).slice(0, 32)}`,
    model: credential.model,
    prompt,
    maxOutputTokens: BUILTIN_MAX_OUTPUT_TOKENS,
  });
  if (!parsed.success) throw invalidBuiltinChatInput();
  return parsed.data;
}

function toBuiltinMessageStream(
  input: SendMessageInput,
  response: BuiltinModelResponse,
): AsyncIterable<MessageEvent> {
  const digest = builtinChatDigest(input);
  const runId = `run_${digest.slice(0, 32)}`;
  const createdAt = new Date().toISOString();
  const events: MessageEvent[] = [
    { type: "started", runId, sessionId: input.sessionId },
    { type: "delta", runId, mode: "append", text: response.output },
    {
      type: "final",
      runId,
      message: {
        id: `msg_${digest.slice(0, 32)}`,
        sessionId: input.sessionId,
        runId,
        role: "assistant",
        status: "completed",
        blocks: [{ id: `block_${digest.slice(0, 32)}`, type: "text", text: response.output, format: "markdown" }],
        createdAt,
      },
    },
  ];
  return (async function* (): AsyncIterable<MessageEvent> {
    for (const event of events) yield MessageEventSchema.parse(event);
  })();
}

function externalSource(provider: ProviderConfigEntry): "domestic" | "custom" {
  return provider.templateId === undefined ? "custom" : "domestic";
}

function hasTypedUClawError(error: unknown): boolean {
  return UClawErrorSchema.safeParse((error as { uclawError?: unknown } | null)?.uclawError).success;
}

export function createModelSourceRouter<Request, Result>({
  providers,
  credentials,
  executors,
}: CreateModelSourceRouterOptions<Request, Result>) {
  return {
    async execute(request: Request, signal?: AbortSignal): Promise<Result> {
      const provider = await providers.getSelectedForRuntime();
      if (provider !== null) {
        const source = externalSource(provider);
        try {
          const network = await providers.getNetworkForRuntime();
          return await executors[source](request, provider, signal, network);
        } catch (error) {
          if (error instanceof ModelSourceFailure && error.source === source) throw error;
          if (hasTypedUClawError(error)) throw error;
          throw new ModelSourceFailure(source, "upstream");
        }
      }

      let credential: BuiltinModelCredential;
      try {
        credential = await credentials.loadActive();
      } catch {
        throw new ModelSourceFailure("builtin", "configuration");
      }
      try {
        return await executors.builtin(request, credential, signal);
      } catch (error) {
        if (error instanceof BuiltinServiceClientError || (error instanceof Error && error.name === "BuiltinServiceClientError")) throw error;
        if (error instanceof ModelSourceFailure && error.source === "builtin") throw error;
        throw new ModelSourceFailure("builtin", "upstream");
      }
    },
  };
}

export function createMainProcessModelRouting({
  dataDir,
  platformForTest,
  allowUnpinnedFilesystemForTest,
  providers,
  executors,
  allowLoopbackHttp = false,
  legacyBuiltinClient = createRemovedBuiltinServiceClient(),
}: CreateMainProcessModelRoutingOptions) {
  const credentials = createBuiltinCredentialStore({
    dataDir, allowLoopbackHttp, platformForTest, allowUnpinnedFilesystemForTest,
  });
  const builtin = async (
    input: SendMessageInput,
    credential: BuiltinModelCredential,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<MessageEvent>> => {
    const request = toBuiltinModelRequest(input, credential);
    const response = await legacyBuiltinClient.execute(request, credential, signal);
    return toBuiltinMessageStream(input, response);
  };
  const router = createModelSourceRouter({ providers, credentials, executors: { ...executors, builtin } });
  return { credentials, routeChatSend: router.execute };
}
