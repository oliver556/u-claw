import type { ThemeConfig } from "antd";
import { theme } from "antd";

import type { ResolvedTheme } from "./settings";

export type SemanticCssVariables = Record<`--uclaw-${string}`, string>;

// Frozen product palettes. Business components consume only these semantic variables.
export const lightSemanticCssVariables: SemanticCssVariables = {
  "--uclaw-bg-window": "#f5f5f5",
  "--uclaw-bg-titlebar": "#fafafa",
  "--uclaw-bg-sidebar": "#fafafa",
  "--uclaw-bg-canvas": "#ffffff",
  "--uclaw-bg-elevated": "#ffffff",
  "--uclaw-bg-input": "#ffffff",
  "--uclaw-bg-hover": "rgba(0, 0, 0, 0.04)",
  "--uclaw-bg-selected": "#e6f4ff",
  "--uclaw-bg-mask": "rgba(0, 0, 0, 0.45)",
  "--uclaw-image-preview-backdrop": "rgba(8, 10, 12, .94)",
  "--uclaw-bg-primary": "#ffffff",
  "--uclaw-bg-secondary": "#f5f5f5",
  "--uclaw-text-primary": "rgba(0, 0, 0, 0.88)",
  "--uclaw-text-secondary": "rgba(0, 0, 0, 0.65)",
  "--uclaw-text-tertiary": "rgba(0, 0, 0, 0.45)",
  "--uclaw-text-disabled": "rgba(0, 0, 0, 0.25)",
  "--uclaw-icon-primary": "rgba(0, 0, 0, 0.65)",
  "--uclaw-icon-muted": "rgba(0, 0, 0, 0.45)",
  "--uclaw-border-primary": "#d9d9d9",
  "--uclaw-border-secondary": "rgba(5, 5, 5, 0.06)",
  "--uclaw-primary": "#1677ff",
  "--uclaw-primary-hover": "#4096ff",
  "--uclaw-primary-active": "#0958d9",
  "--uclaw-primary-border": "#91caff",
  "--uclaw-primary-text": "#1677ff",
  "--uclaw-primary-soft": "#e6f4ff",
  "--uclaw-focus-ring": "rgba(22, 119, 255, 0.35)",
  "--uclaw-success": "#52c41a",
  "--uclaw-success-bg": "#f6ffed",
  "--uclaw-warning": "#faad14",
  "--uclaw-warning-bg": "#fffbe6",
  "--uclaw-error": "#ff4d4f",
  "--uclaw-error-bg": "#fff2f0",
  "--uclaw-error-border": "#ffccc7",
  "--uclaw-error-text": "#cf1322",
  "--uclaw-info": "#1677ff",
  "--uclaw-info-bg": "#e6f4ff",
  "--uclaw-close-hover": "#c42b1c",
  "--uclaw-on-accent": "#ffffff",
  "--uclaw-shadow": "rgba(5, 5, 5, 0.12)",
  "--uclaw-shadow-lg": "rgba(5, 5, 5, 0.18)",
};

export const darkSemanticCssVariables: SemanticCssVariables = {
  "--uclaw-bg-window": "#141414",
  "--uclaw-bg-titlebar": "#141414",
  "--uclaw-bg-sidebar": "#141414",
  "--uclaw-bg-canvas": "#1f1f1f",
  "--uclaw-bg-elevated": "#262626",
  "--uclaw-bg-input": "#1f1f1f",
  "--uclaw-bg-hover": "rgba(255, 255, 255, 0.08)",
  "--uclaw-bg-selected": "#111a2c",
  "--uclaw-bg-mask": "rgba(0, 0, 0, 0.65)",
  "--uclaw-image-preview-backdrop": "rgba(8, 10, 12, .94)",
  "--uclaw-bg-primary": "#1f1f1f",
  "--uclaw-bg-secondary": "#181818",
  "--uclaw-text-primary": "rgba(255, 255, 255, 0.85)",
  "--uclaw-text-secondary": "rgba(255, 255, 255, 0.65)",
  "--uclaw-text-tertiary": "rgba(255, 255, 255, 0.45)",
  "--uclaw-text-disabled": "rgba(255, 255, 255, 0.25)",
  "--uclaw-icon-primary": "rgba(255, 255, 255, 0.65)",
  "--uclaw-icon-muted": "rgba(255, 255, 255, 0.45)",
  "--uclaw-border-primary": "#424242",
  "--uclaw-border-secondary": "#303030",
  "--uclaw-primary": "#1668dc",
  "--uclaw-primary-hover": "#3c89e8",
  "--uclaw-primary-active": "#1554ad",
  "--uclaw-primary-border": "#15325b",
  "--uclaw-primary-text": "#69b1ff",
  "--uclaw-primary-soft": "#111a2c",
  "--uclaw-focus-ring": "rgba(105, 177, 255, 0.45)",
  "--uclaw-success": "#49aa19",
  "--uclaw-success-bg": "#162312",
  "--uclaw-warning": "#d89614",
  "--uclaw-warning-bg": "#2b2111",
  "--uclaw-error": "#dc4446",
  "--uclaw-error-bg": "#2a1215",
  "--uclaw-error-border": "#58181c",
  "--uclaw-error-text": "#ff7875",
  "--uclaw-info": "#1668dc",
  "--uclaw-info-bg": "#111a2c",
  "--uclaw-close-hover": "#c42b1c",
  "--uclaw-on-accent": "#ffffff",
  "--uclaw-shadow": "rgba(0, 0, 0, 0.32)",
  "--uclaw-shadow-lg": "rgba(0, 0, 0, 0.48)",
};

const seedTokens: NonNullable<ThemeConfig["token"]> = {
    colorPrimary: "#1677ff",
    colorInfo: "#1677ff",
    colorSuccess: "#52c41a",
    colorWarning: "#faad14",
    colorError: "#ff4d4f",
    borderRadius: 6,
    fontFamily: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
};

export function semanticCssVariablesFor(resolvedTheme: ResolvedTheme): SemanticCssVariables {
  return resolvedTheme === "dark" ? darkSemanticCssVariables : lightSemanticCssVariables;
}

export function appThemeFor(resolvedTheme: ResolvedTheme): ThemeConfig {
  return {
    algorithm: resolvedTheme === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: seedTokens,
  };
}
