import {
  ImageOperationIpcResponseSchema,
  UClawErrorSchema,
  type ImageOperationIpcRequest,
  type ImageOperationIpcResponse,
} from "@uclaw/shared";

import type { ImageOperationService } from "./image-operation-service.js";

export type ImageOperationDispatcher = ((request: ImageOperationIpcRequest) => Promise<ImageOperationIpcResponse>) & { dispose(): void };

export function createImageOperationDispatcher(service: ImageOperationService): ImageOperationDispatcher {
  const dispatch = async (request: ImageOperationIpcRequest) => {
    try {
      const result = request.method === "image.copy"
        ? await service.copy(request.params)
        : await service.save(request.params);
      return ImageOperationIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
    } catch (caught) {
      const parsed = UClawErrorSchema.safeParse(caught);
      const error = parsed.success
        ? parsed.data
        : UClawErrorSchema.parse({
          code: "OPERATION_FAILED",
          message: request.method === "image.copy" ? "无法复制此图片。" : "图片保存失败，请重试。",
          retryable: true,
          recoveryActions: ["retry"],
          causeDetails: {},
        });
      return ImageOperationIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: false, error });
    }
  };
  return Object.assign(dispatch, { dispose: () => service.dispose() });
}
