// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CapabilitiesView } from "../src/features/capabilities/CapabilitiesView.js";

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "uclaw", { value: undefined, configurable: true });
});

describe("CapabilitiesView public navigation", () => {
  it("shows the marketplace and installed Skills without advanced capability entry points", async () => {
    const invoke = vi.fn(async (request: { method: string; requestId: string }) => ({
      method: request.method,
      requestId: request.requestId,
      ok: true,
      result: request.method === "skills.search"
        ? { items: [], nextCursor: null, hasMore: false, mode: "fixture" }
        : request.method === "skills.runtime-status"
          ? { workspaceDir: "w", managedSkillsDir: "m", skills: [] }
          : [],
    }));
    Object.defineProperty(window, "uclaw", { configurable: true, value: { skills: { invoke } } });

    render(<CapabilitiesView />);

    expect(await screen.findByRole("heading", { name: "技能商城" })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "我的技能" }));
    expect(await screen.findByText("尚未安装 Skill")).toBeVisible();
    expect(screen.getByRole("heading", { name: "我的技能" })).toBeVisible();
    expect(screen.queryByRole("tablist", { name: "能力类型" })).not.toBeInTheDocument();
    for (const label of ["模型", "用量", "插件", "MCP", "运行状态", "Curator", "Proposals", "免费目录"]) {
      expect(screen.queryByRole("tab", { name: label })).not.toBeInTheDocument();
    }
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "skills.installed" }));
  });
});
