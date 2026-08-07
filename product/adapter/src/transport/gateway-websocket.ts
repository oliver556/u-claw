import { z } from "zod";

import { RpcRouter, type JsonValue } from "./rpc-router.js";

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: string }) => void): void;
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: string }) => void): void;
}

const ChallengeSchema = z.object({
  nonce: z.string().min(1),
  ts: z.union([z.string(), z.number()]),
});
export type GatewayChallenge = z.infer<typeof ChallengeSchema>;

const ConnectParamsSchema = z.object({
  client: z.object({ id: z.literal("u-claw-desktop"), mode: z.string().min(1) }),
  role: z.literal("operator"),
  scopes: z.array(z.string().min(1)),
  caps: z.array(z.string().min(1)).default([]),
  auth: z.object({
    token: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    deviceToken: z.string().min(1).optional(),
  }).strict().optional(),
  device: z.record(z.string(), z.json()).optional(),
}).strict();
export type GatewayConnectParams = z.input<typeof ConnectParamsSchema>;

export const HelloOkSchema = z.object({
  type: z.literal("hello-ok"),
  protocol: z.literal(4),
  server: z.object({ version: z.string().min(1) }),
  features: z.object({
    methods: z.array(z.string()),
    events: z.array(z.string()),
  }),
  policy: z.object({
    maxPayload: z.number().int().positive(),
    maxBufferedBytes: z.number().int().positive(),
  }),
});
export type HelloOk = z.infer<typeof HelloOkSchema>;

export type GatewayWebSocketState = "idle" | "connecting" | "authenticating" | "ready" | "failed" | "closed";

export interface GatewayWebSocketOptions {
  url: string;
  webSocketFactory(url: string): WebSocketLike;
  connectParams(challenge: GatewayChallenge): GatewayConnectParams;
  requestTimeoutMs?: number;
  challengeTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
}

export class GatewayWebSocket {
  state: GatewayWebSocketState = "idle";
  private socket: WebSocketLike | undefined;
  private activeRouter: RpcRouter | undefined;

  constructor(private readonly options: GatewayWebSocketOptions) {}

  get router(): RpcRouter {
    if (this.activeRouter === undefined) throw new Error("Gateway is not connected");
    return this.activeRouter;
  }

  connect(): Promise<HelloOk> {
    if (this.state === "connecting" || this.state === "authenticating") {
      return Promise.reject(new Error("Gateway connection already in progress"));
    }
    this.state = "connecting";
    const socket = this.options.webSocketFactory(this.options.url);
    this.socket = socket;
    const router = new RpcRouter(socket, {
      requestTimeoutMs: this.options.requestTimeoutMs,
      onDiagnostic: this.options.onDiagnostic,
    });
    this.activeRouter = router;

    return new Promise<HelloOk>((resolve, reject) => {
      let settled = false;
      let removeChallenge = (): void => undefined;
      const handshakeTimeout = setTimeout(() => fail(new Error("Gateway challenge timed out")), this.options.challengeTimeoutMs ?? 750);
      const fail = (reason: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimeout);
        removeChallenge();
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        router.close();
        socket.close(1002, "handshake failed");
        this.state = "failed";
        reject(reason);
      };
      const onError = (): void => fail(new Error("Gateway WebSocket failed"));
      const onClose = (): void => {
        if (this.state === "ready") {
          this.state = "closed";
          return;
        }
        if (this.state !== "closed") fail(new Error("Gateway WebSocket closed during handshake"));
      };
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      socket.addEventListener("open", () => {
        if (settled) return;
        removeChallenge = router.onEvent("connect.challenge", (frame) => {
          const challenge = ChallengeSchema.safeParse(frame.payload);
          if (!challenge.success) {
            fail(new Error("Gateway challenge failed validation"));
            return;
          }
          removeChallenge();
          this.state = "authenticating";
          let supplied: z.output<typeof ConnectParamsSchema>;
          try {
            supplied = ConnectParamsSchema.parse(this.options.connectParams(challenge.data));
          } catch (error) {
            fail(error instanceof Error ? error : new Error("Gateway connect parameters failed"));
            return;
          }
          const params: JsonValue = {
            client: { id: supplied.client.id, mode: supplied.client.mode },
            role: supplied.role,
            scopes: supplied.scopes,
            caps: supplied.caps,
            ...(supplied.auth === undefined ? {} : { auth: supplied.auth }),
            ...(supplied.device === undefined ? {} : { device: supplied.device }),
            minProtocol: 4,
            maxProtocol: 4,
            challenge: { nonce: challenge.data.nonce, ts: challenge.data.ts },
          };
          void router.request("connect", params, HelloOkSchema).then((hello) => {
            if (settled) return;
            settled = true;
            clearTimeout(handshakeTimeout);
            socket.removeEventListener("error", onError);
            this.state = "ready";
            resolve(hello);
          }, (error: Error) => fail(error));
        });
      });
    });
  }

  close(): void {
    this.activeRouter?.close();
    this.socket?.close(1000, "client closed");
    this.state = "closed";
  }
}
