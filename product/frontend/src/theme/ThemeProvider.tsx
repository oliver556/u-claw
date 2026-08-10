import { ConfigProvider } from "antd";
import { createContext, type PropsWithChildren, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";

import { readThemePreference, resolveTheme, type ResolvedTheme, type ThemePreference, writeThemePreference } from "./settings";
import { appThemeFor, semanticCssVariablesFor } from "./tokens";

type AppThemeContextValue = {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference(preference: ThemePreference): void;
};

const AppThemeContext = createContext<AppThemeContextValue | undefined>(undefined);
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export function AppThemeProvider({ children }: PropsWithChildren) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readThemePreference(window.localStorage));
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.(SYSTEM_DARK_QUERY).matches ?? false);
  const resolvedTheme = resolveTheme(preference, systemDark);

  useEffect(() => {
    const media = window.matchMedia?.(SYSTEM_DARK_QUERY);
    if (!media) return;
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.style.colorScheme = resolvedTheme;
    for (const [name, value] of Object.entries(semanticCssVariablesFor(resolvedTheme))) {
      root.style.setProperty(name, value);
    }
  }, [resolvedTheme]);

  const value = useMemo<AppThemeContextValue>(() => ({
    preference,
    resolvedTheme,
    setPreference(next) {
      writeThemePreference(window.localStorage, next);
      setPreferenceState(next);
    },
  }), [preference, resolvedTheme]);

  return <AppThemeContext.Provider value={value}>
    <ConfigProvider theme={appThemeFor(resolvedTheme)}>{children}</ConfigProvider>
  </AppThemeContext.Provider>;
}

export function useAppTheme(): AppThemeContextValue {
  const value = useContext(AppThemeContext);
  if (!value) throw new Error("useAppTheme must be used within AppThemeProvider");
  return value;
}
