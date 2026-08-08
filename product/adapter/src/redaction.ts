import { redactRendererValue, type RendererRedactedValue } from "@uclaw/shared";

export function redactAdapterLog(_message: string): string {
  return "Gateway diagnostic event.";
}

export function redactAdapterRecord(
  record: Record<string, unknown>,
): Record<string, RendererRedactedValue> {
  try {
    if (record === null || typeof record !== "object" || Array.isArray(record) || Object.getPrototypeOf(record) !== Object.prototype) {
      return {};
    }
    return redactRendererValue(record) as Record<string, RendererRedactedValue>;
  } catch {
    return {};
  }
}
