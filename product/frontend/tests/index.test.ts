import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { packageName } from "../src/index";

describe("frontend workspace", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@uclaw/frontend");
  });

  it("restores the U-Claw theme before the renderer module starts", () => {
    const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
    const bootstrap = html.indexOf("uclaw.settings.v1");
    const renderer = html.indexOf('type="module"');

    expect(bootstrap).toBeGreaterThan(0);
    expect(bootstrap).toBeLessThan(renderer);
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("dataset.theme");
    expect(html).toContain('content="light dark"');
    expect(html).toContain('html[data-theme="dark"]');
  });

  it("uses defined semantic colors across business surfaces", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/theme/global.css", import.meta.url)), "utf8");
    const tokens = readFileSync(fileURLToPath(new URL("../src/theme/tokens.ts", import.meta.url)), "utf8");
    const used = [...css.matchAll(/var\((--uclaw-[a-z0-9-]+)/g)].map((match) => match[1]);
    const defined = new Set([...tokens.matchAll(/"(--uclaw-[a-z0-9-]+)"/g)].map((match) => match[1]));
    expect([...new Set(used.filter((name) => !defined.has(name)))]).toEqual([]);

    const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
    const businessSource = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(?:css|ts|tsx)$/.test(file) && file.replaceAll("\\", "/") !== "theme/tokens.ts")
      .map((file) => readFileSync(join(sourceRoot, file), "utf8"))
      .join("\n");
    // QR codes require a white scan surface in both themes.
    const withoutQrSurface = businessSource.replace(/\.wechat-qr-frame\s*\{[^}]+\}/, "");
    expect(withoutQrSurface.match(/#[0-9a-f]{3,8}|rgba?\([^)]*\)|rgb\([^)]*\)/gi) ?? []).toEqual([]);
    expect(withoutQrSurface).not.toMatch(/(?:color|background):\s*(?:white|black)\b/i);
  });

  it("keeps the composer chrome quiet while its textarea is focused", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/theme/global.css", import.meta.url)), "utf8");
    expect(css).not.toMatch(/\.composer:focus-within\s*\{/);
  });

  it("keeps the dark work canvas deeper than its navigation and composer", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/theme/global.css", import.meta.url)), "utf8");
    expect(css).toContain('html[data-theme="dark"] .workspace-grid:not(.secondary-layout) .main-canvas');
    expect(css).toContain("background: var(--uclaw-bg-window)");
    expect(css).toContain('html[data-theme="dark"] .workspace-grid:not(.secondary-layout) .session-panel');
    expect(css).toContain("background: var(--uclaw-bg-canvas)");
  });

  it("renders chat messages without outlined bubbles", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/theme/global.css", import.meta.url)), "utf8");
    expect(css).toContain(".assistant-message > .message-content { border: 0; padding-left: 0; padding-right: 0; background: transparent; }");
    expect(css).toContain(".user-message > .message-content { color: var(--uclaw-text-primary); border: 0; background: var(--uclaw-bg-secondary); padding: 7px 11px; }");
    expect(css).toContain('html[data-theme="dark"] .user-message > .message-content { background: var(--uclaw-bg-elevated); }');
  });

  it("aligns the conversation content with the composer width", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/theme/global.css", import.meta.url)), "utf8");
    expect(css).toContain("padding: 24px max(28px, calc((100% - 780px) / 2)) 20px");
    expect(css).not.toContain("padding: 24px max(28px, calc((100% - 760px) / 2)) 20px");
  });

  it("keeps user message bubble padding compact", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/theme/global.css", import.meta.url)), "utf8");
    expect(css).toContain(".user-message > .message-content { color: var(--uclaw-text-primary); border: 0; background: var(--uclaw-bg-secondary); padding: 7px 11px; }");
    expect(css).toContain(".user-message > .message-content > p:first-child { margin-top: 0; }");
    expect(css).toContain(".user-message > .message-content > p:last-child { margin-bottom: 0; }");
  });

  it("aligns assistant reply text with the processing divider", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/theme/global.css", import.meta.url)), "utf8");
    expect(css).toContain(".assistant-message > .message-content { border: 0; padding-left: 0; padding-right: 0; background: transparent; }");
  });

  it("aligns composer tools and uses circular action controls", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/theme/global.css", import.meta.url)), "utf8");
    expect(css).toContain(".composer-tools > button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; }");
    expect(css).toContain(".composer .composer-action { width: 30px; min-width: 30px; height: 30px; min-height: 30px; border-radius: 50%;");
  });

  it("uses a readable Chinese typography rhythm in chat messages", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/theme/global.css", import.meta.url)), "utf8");
    expect(css).toContain('.message-content { font-family: "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif; font-size: 15px; font-weight: 400; line-height: 1.72; letter-spacing: 0; }');
    expect(css).toContain(".message-content > p { margin: 0 0 12px; line-height: inherit;");
    expect(css).toContain(".message-content h2 { margin: 22px 0 12px; font-size: 21px; line-height: 1.4; font-weight: 600; }");
    expect(css).toContain(".message-content li + li { margin-top: 3px; }");
    expect(css).toContain(".message-content strong { font-weight: 600; }");
  });
});
