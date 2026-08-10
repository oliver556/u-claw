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
});
