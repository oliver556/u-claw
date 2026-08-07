import { z } from "zod";

import { redactAdapterLog } from "../redaction.js";

export type JsonValue = z.output<ReturnType<typeof z.json>>;

const EventFrameSchema = z.object({
  type: z.literal("event"),
  event: z.string().min(1),
  payload: z.json(),
  seq: z.number().int().nonnegative().optional(),
  stateVersion: z.number().int().nonnegative().optional(),
});

const SuccessResponseSchema = z.object({
  type: z.literal("res"),
  id: z.string().min(1),
  ok: z.literal(true),
  payload: z.json(),
});

const ErrorResponseSchema = z.object({
  type: z.literal("res"),
  id: z.string().min(1),
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean().optional(),
    retryAfterMs: z.number().int().nonnegative().optional(),
  }),
});

const IncomingFrameSchema = z.union([
  EventFrameSchema,
  SuccessResponseSchema,
  ErrorResponseSchema,
]);

export type EventFrame = z.infer<typeof EventFrameSchema>;

export class RpcTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`RPC timed out: ${method}`);
    this.name = "RpcTimeoutError";
  }
}

export class RpcClosedError extends Error {
  constructor() {
    super("Gateway connection closed");
    this.name = "RpcClosedError";
  }
}

export class RpcRemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(redactAdapterLog(message));
    this.name = "RpcRemoteError";
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
  private readonly requestTimeoutMs: number;
  private readonly onDiagnostic: (message: string) => void;
  private readonly idFactory: () => string;
  private closed = false;

  constructor(private readonly socket: RpcSocketLike, options: RpcRouterOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.idFactory = options.idFactory ?? (() => `rpc-${++this.nextId}`);
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
      this.socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  onEvent(event: string, listener: (frame: EventFrame) => void): () => void {
    const listeners = this.eventListeners.get(event) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(event, listeners);
    return () => listeners.delete(listener);
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
      pending.reject(new RpcRemoteError("PROTOCOL_MAPPING_FAILED", "Gateway response failed validation"));
      return;
    }
    pending.resolve(payload.data);
  };

  private readonly handleClose = (): void => {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new RpcClosedError());
    }
    this.pending.clear();
    this.eventListeners.clear();
  };
}
