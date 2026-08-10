export const THEME_SETTINGS_KEY = "uclaw.settings.v1";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function readSettings(storage: StorageLike): Record<string, unknown> {
  try {
    const parsed = JSON.parse(storage.getItem(THEME_SETTINGS_KEY) ?? "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function readThemePreference(storage: StorageLike): ThemePreference {
  const settings = readSettings(storage);
  const appearance = settings.appearance;
  if (appearance === null || typeof appearance !== "object" || Array.isArray(appearance)) return "system";
  const value = (appearance as Record<string, unknown>).theme;
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function writeThemePreference(storage: StorageLike, theme: ThemePreference): void {
  try {
    const settings = readSettings(storage);
    const appearance = settings.appearance;
    settings.appearance = {
      ...(appearance !== null && typeof appearance === "object" && !Array.isArray(appearance) ? appearance : {}),
      theme,
    };
    storage.setItem(THEME_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // A read-only storage environment still gets the in-memory theme for this session.
  }
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}
