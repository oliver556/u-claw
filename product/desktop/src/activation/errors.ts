export type ActivationClientErrorCode =
  | "ACTIVATION_INVALID"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "REDIRECT_REJECTED"
  | string;

export class ActivationClientError extends Error {
  constructor(
    readonly code: ActivationClientErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly supportCode?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ActivationClientError";
  }
}

