import type { CSSProperties } from "react";
import type { ThemeConfig } from "antd";
import { theme } from "antd";

// Frozen Ant Design light palette. Business components consume only semantic CSS variables.
export const semanticCssVariables = {
  "--uclaw-bg-window": "#f5f5f5",
  "--uclaw-bg-titlebar": "#fafafa",
  "--uclaw-bg-sidebar": "#fafafa",
  "--uclaw-bg-canvas": "#ffffff",
  "--uclaw-bg-elevated": "#ffffff",
  "--uclaw-bg-input": "#ffffff",
  "--uclaw-bg-hover": "rgba(0, 0, 0, 0.04)",
  "--uclaw-bg-selected": "#e6f4ff",
  "--uclaw-bg-mask": "rgba(0, 0, 0, 0.45)",
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
  "--uclaw-focus-ring": "rgba(22, 119, 255, 0.35)",
  "--uclaw-success": "#52c41a",
  "--uclaw-success-bg": "#f6ffed",
  "--uclaw-warning": "#faad14",
  "--uclaw-warning-bg": "#fffbe6",
  "--uclaw-error": "#ff4d4f",
  "--uclaw-error-bg": "#fff2f0",
  "--uclaw-info": "#1677ff",
  "--uclaw-info-bg": "#e6f4ff",
  "--uclaw-close-hover": "#c42b1c",
  "--uclaw-on-accent": "#ffffff",
  "--uclaw-shadow": "rgba(5, 5, 5, 0.12)",
} as CSSProperties;

export const appTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: "#1677ff",
    colorInfo: "#1677ff",
    colorSuccess: "#52c41a",
    colorWarning: "#faad14",
    colorError: "#ff4d4f",
    colorBgBase: "#ffffff",
    colorTextBase: "#000000",
    borderRadius: 6,
    fontFamily: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  },
};
