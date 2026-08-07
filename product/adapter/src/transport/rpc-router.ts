import { UClawErrorCodeSchema, UClawErrorSchema, type UClawError } from "@uclaw/shared";
import { z } from "zod";

import { redactAdapterLog } from "../redaction.js";
import { SequenceGapDetector, type SequenceGap } from "../reconnect.js";

export type JsonValue = z.output<ReturnType<typeof z.json>>;

const EventFrameSchema = z.object({
  type: z.literal("event"),
  event: z.string().min(1),
  payload: z.json(),
  seq: z.number().int().nonnegative().optional(),
  stateVersion: z.number().int().nonnegative().optional(),
}).strict();

const SuccessResponseSchema = z.object({
  type: z.literal("res"),
  id: z.string().min(1),
  ok: z.literal(true),
  payload: z.json(),
}).strict();

const ErrorResponseSchema = z.object({
  type: z.literal("res"),
  id: z.string().min(1),
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean().optional(),
    retryAfterMs: z.number().int().nonnegative().optional(),
  }).strict(),
}).strict();

const IncomingFrameSchema = z.union([
  EventFrameSchema,
  SuccessResponseSchema,
  ErrorResponseSchema,
]);

export type EventFrame = z.infer<typeof EventFrameSchema>;

export class AdapterServiceError extends Error {
  constructor(message: string, readonly uclawError: UClawError) {
    super(message);
    this.name = "AdapterServiceError";
  }
}

export class RpcTimeoutError extends AdapterServiceError {
  constructor(readonly method: string) {
    const message = `RPC timed out: ${method}`;
    super(message, UClawErrorSchema.parse({
      code: "TIMEOUT", message, retryable: true,
      recoveryActions: ["retry"], causeDetails: { operation: method },
    }));
    this.name = "RpcTimeoutError";
  }
}

export class RpcClosedError extends AdapterServiceError {
  constructor() {
    const message = "Gateway connection closed";
    super(message, UClawErrorSchema.parse({
      code: "GATEWAY_DISCONNECTED", message, retryable: true,
      recoveryActions: ["reconnect"], causeDetails: {},
    }));
    this.name = "RpcClosedError";
  }
}

export class RpcRemoteError extends AdapterServiceError {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    const safeMessage = redactAdapterLog(message);
    const knownCode = UClawErrorCodeSchema.safeParse(code);
    super(safeMessage, UClawErrorSchema.parse({
      code: knownCode.success ? knownCode.data : "OPERATION_FAILED",
      message: safeMessage,
      retryable,
      recoveryActions: retryable ? ["retry"] : [],
      causeDetails: {
        upstreamCode: code,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    }));
    this.name = "RpcRemoteError";
  }
}

export class RpcProtocolError extends AdapterServiceError {
  constructor(readonly method: string) {
    const message = "Gateway response failed validation";
    super(message, UClawErrorSchema.parse({
      code: "PROTOCOL_MAPPING_FAILED", message, retryable: false,
      recoveryActions: ["open-diagnostics"], causeDetails: { operation: method },
    }));
    this.name = "RpcProtocolError";
  }
}

interface PendingRequest<T = JsonValue> {
  method: string;
  schema: z.ZodType<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface RpcSocketLike {
  send(data: string): void;
  addEventListener(type: "message" | "close", listener: (event: { data?: string }) => void): void;
  removeEventListener(type: "message" | "close", listener: (event: { data?: string }) => void): void;
}

export interface RpcRouterOptions {
  requestTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
  idFactory?: () => string;
}

export class RpcRouter {
  private nextId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Map<string, Set<(event: EventFrame) => void>>();
  private readonly sequenceGapListeners = new Set<(gap: SequenceGap) => void>();
  private readonly closeListeners = new Set<(error: RpcClosedError) => void>();
  private readonly unorderedControlEvents = new Set(["connect.challenge"]);
  private readonly sequenceDetector: SequenceGapDetector;
  private readonly requestTimeoutMs: number;
  private readonly onDiagnostic: (message: string) => void;
  private readonly idFactory: () => string;
  private closed = false;

  constructor(private readonly socket: RpcSocketLike, options: RpcRouterOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.idFactory = options.idFactory ?? (() => `rpc-${++this.nextId}`);
    this.sequenceDetector = new SequenceGapDetector((gap) => {
      for (const listener of this.sequenceGapListeners) listener(gap);
    });
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleClose);
  }

  request<T>(method: string, params: JsonValue, schema: z.ZodType<T>): Promise<T> {
    if (this.closed) return Promise.reject(new RpcClosedError());
    const id = this.idFactory();
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(method));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, schema, resolve, reject, timeout } as PendingRequest);
      try {
        this.socket.send(JSON.stringify({ type: "req", id, method, params }));
      } catch {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new RpcClosedError());
      }
    });
  }

  onEvent(event: string, listener: (frame: EventFrame) => void): () => void {
    const listeners = this.eventListeners.get(event) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  onSequenceGap(listener: (gap: SequenceGap) => void): () => void {
    this.sequenceGapListeners.add(listener);
    return () => this.sequenceGapListeners.delete(listener);
  }

  onClose(listener: (error: RpcClosedError) => void): () => void {
    if (this.closed) {
      listener(new RpcClosedError());
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  resetSequence(sourceSequence?: number): void {
    this.sequenceDetector.reset(sourceSequence);
  }

  close(): void {
    this.handleClose();
    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.removeEventListener("close", this.handleClose);
  }

  private readonly handleMessage = (event: { data?: string }): void => {
    if (typeof event.data !== "string") {
      this.onDiagnostic("Ignored non-text Gateway frame");
      return;
    }
    let decoded: JsonValue;
    try {
      decoded = z.json().parse(JSON.parse(event.data));
    } catch {
      this.onDiagnostic("Ignored malformed Gateway frame");
      return;
    }
    const parsed = IncomingFrameSchema.safeParse(decoded);
    if (!parsed.success) {
      this.onDiagnostic("Ignored unknown Gateway frame");
      return;
    }
    const frame = parsed.data;
    if (frame.type === "event") {
      const controlEvent = this.unorderedControlEvents.has(frame.event);
      const decision = controlEvent
        ? "accepted"
        : frame.seq === undefined
          ? this.sequenceDetector.isDesynced ? "desynced" : "accepted"
          : this.sequenceDetector.observe(frame.seq);
      if (decision !== "accepted") return;
      for (const listener of this.eventListeners.get(frame.event) ?? []) listener(frame);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (pending === undefined) {
      this.onDiagnostic("Ignored response for unknown request");
      return;
    }
    this.pending.delete(frame.id);
    clearTimeout(pending.timeout);
    if (!frame.ok) {
      pending.reject(new RpcRemoteError(frame.error.code, frame.error.message, frame.error.retryable, frame.error.retryAfterMs));
      return;
    }
    const payload = pending.schema.safeParse(frame.payload);
    if (!payload.success) {
      pending.reject(new RpcProtocolError(pending.method));
      return;
    }
    pending.resolve(payload.data);
  };

  private readonly handleClose = (): void => {
    if (this.closed) return;
    this.closed = true;
    const error = new RpcClosedError();
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
    this.eventListeners.clear();
    this.sequenceGapListeners.clear();
  };
}
