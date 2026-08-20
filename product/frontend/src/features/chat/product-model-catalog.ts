interface RuntimeModel {
  id: string;
  label: string;
  available: boolean;
}

export function toProductModels(items: RuntimeModel[]): RuntimeModel[] {
  return items.map((item) => ({ ...item }));
}
