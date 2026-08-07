import {
  redactRendererRecord,
  redactRendererText,
  type RendererSafeValue,
} from "@uclaw/shared";

export function redactAdapterLog(message: string): string {
  return redactRendererText(message);
}

export function redactAdapterRecord(
  record: Record<string, RendererSafeValue>,
): Record<string, RendererSafeValue> {
  return redactRendererRecord(record);
}
