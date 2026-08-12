export const DEFAULT_PRODUCT_MODEL = {
  productId: "gpt",
  modelId: "gpt-5.6-sol",
  label: "GPT-5.6 Sol",
} as const;

interface RuntimeModel {
  id: string;
  label: string;
  available: boolean;
}

export function toProductModels(items: RuntimeModel[]): RuntimeModel[] {
  return items
    .filter((item) => item.id === DEFAULT_PRODUCT_MODEL.modelId || item.id.endsWith(`/${DEFAULT_PRODUCT_MODEL.modelId}`))
    .map((item) => ({ ...item, label: DEFAULT_PRODUCT_MODEL.label }));
}
