import type {
  BuiltinModelRequest,
  BuiltinModelResponse,
  BuiltinServiceHealth,
  NewApiErrorCategory,
} from "@uclaw/shared";

import type { BuiltinModelCredential } from "./builtin-credential-store.js";

export interface BuiltinServiceClient {
  execute(
    request: BuiltinModelRequest,
    credential: BuiltinModelCredential,
    signal?: AbortSignal,
  ): Promise<BuiltinModelResponse>;
  health(credential: BuiltinModelCredential, signal?: AbortSignal): Promise<BuiltinServiceHealth>;
}

export class BuiltinServiceClientError extends Error {
  readonly causeDetails = {};

  constructor(
    readonly category: NewApiErrorCategory,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "BuiltinServiceClientError";
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      category: this.category,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      causeDetails: this.causeDetails,
    };
  }
}

export function createRemovedBuiltinServiceClient(): BuiltinServiceClient {
  const removed = async (): Promise<never> => {
    throw new BuiltinServiceClientError("transport", "NETWORK_ERROR", "Builtin service request failed.", true);
  };
  return { execute: removed, health: removed };
}
