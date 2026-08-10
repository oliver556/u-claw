// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { theme as antdTheme } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "../src/app/providers";
import { readThemePreference, THEME_SETTINGS_KEY, writeThemePreference } from "../src/theme/settings";
import { useAppTheme } from "../src/theme/ThemeProvider";

type MediaListener = (event: MediaQueryListEvent) => void;

function installColorScheme(dark: boolean) {
  const listeners = new Set<MediaListener>();
  let matches = dark;
  const media = {
    media: "(prefers-color-scheme: dark)",
    get matches() { return matches; },
    onchange: null,
    addEventListener: (_type: string, listener: MediaListener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: MediaListener) => listeners.delete(listener),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  return {
    setDark(next: boolean) {
      matches = next;
      listeners.forEach((listener) => listener({ matches: next, media: media.media } as MediaQueryListEvent));
    },
  };
}

function ThemeProbe() {
  const { preference, resolvedTheme, setPreference } = useAppTheme();
  const { token } = antdTheme.useToken();
  return <>
    <output data-testid="theme-state">{preference}:{resolvedTheme}</output>
    <output data-testid="antd-surface">{token.colorBgContainer}</output>
    <button type="button" onClick={() => setPreference("light")}>light</button>
    <button type="button" onClick={() => setPreference("dark")}>dark</button>
    <button type="button" onClick={() => setPreference("system")}>system</button>
  </>;
}

describe("application theme", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reads a valid U-Claw appearance setting and rejects invalid values", () => {
    localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify({ appearance: { theme: "dark" } }));
    expect(readThemePreference(localStorage)).toBe("dark");

    localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify({ appearance: { theme: "sepia" } }));
    expect(readThemePreference(localStorage)).toBe("system");
    localStorage.setItem(THEME_SETTINGS_KEY, "not json");
    expect(readThemePreference(localStorage)).toBe("system");
  });

  it("writes the theme without discarding other U-Claw settings", () => {
    localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify({ diagnostics: { verbose: true } }));
    writeThemePreference(localStorage, "dark");
    expect(JSON.parse(localStorage.getItem(THEME_SETTINGS_KEY) ?? "{}")).toEqual({
      diagnostics: { verbose: true },
      appearance: { theme: "dark" },
    });
  });

  it("restores dark mode and applies Ant Design dark tokens and document metadata", () => {
    installColorScheme(false);
    localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify({ appearance: { theme: "dark" } }));
    render(<AppProviders><ThemeProbe /></AppProviders>);

    expect(screen.getByTestId("theme-state")).toHaveTextContent("dark:dark");
    expect(screen.getByTestId("antd-surface")).toHaveTextContent("#141414");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("follows live system changes while keeping the system preference", () => {
    const system = installColorScheme(false);
    render(<AppProviders><ThemeProbe /></AppProviders>);
    expect(screen.getByTestId("theme-state")).toHaveTextContent("system:light");

    act(() => system.setDark(true));
    expect(screen.getByTestId("theme-state")).toHaveTextContent("system:dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("persists explicit mode changes", () => {
    installColorScheme(false);
    render(<AppProviders><ThemeProbe /></AppProviders>);
    fireEvent.click(screen.getByRole("button", { name: "dark" }));

    expect(screen.getByTestId("theme-state")).toHaveTextContent("dark:dark");
    expect(readThemePreference(localStorage)).toBe("dark");
  });
});
