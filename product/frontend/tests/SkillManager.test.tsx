// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";

import { SkillManager } from "../src/features/skills/SkillManager";

afterEach(() => { cleanup(); delete window.uclaw; });

const detail = {
  slug: "command-runner", name: "命令运行器", description: "运行批准命令", version: "1.0.0",
  pricingType: "free", enabled: false, installedVersion: null, updateAvailable: false,
  source: { provider: "skillhub", url: "https://api.skillhub.cn/api/v1/skills/command-runner" },
  permissions: [{ kind: "command", access: "execute", target: "git", risk: "high", reason: "执行 Git 命令" }],
  permissionFingerprint: "permission-hash", risk: "high", mode: "fixture",
};

describe("SkillManager", () => {
  it("renders loading, free catalog, pagination, and offline retry states", async () => {
    let attempts = 0;
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.search" && attempts++ === 0) throw new Error("offline");
      return { method: request.method, requestId: request.requestId, ok: true, result: {
        items: [detail], nextCursor: "1", hasMore: true, mode: "fixture",
      } };
    });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    expect(screen.getByText("正在加载免费技能")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("技能目录离线");
    fireEvent.click(screen.getByRole("button", { name: "重试技能目录" }));
    expect(await screen.findByText("命令运行器")).toBeVisible();
    expect(screen.getByText("本地契约数据")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "加载更多技能" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "skills.search", params: expect.objectContaining({ cursor: "1" }),
    })));
  });

  it("finishes loading under React StrictMode", async () => {
    const invoke = vi.fn(async (request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: { items: [detail], nextCursor: null, hasMore: false, mode: "fixture" } }));
    window.uclaw = { skills: { invoke } } as any;
    render(<StrictMode><SkillManager /></StrictMode>);
    expect(await screen.findByText("命令运行器")).toBeVisible();
  });

  it("shows permission risk and blocks install until explicit confirmation", async () => {
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.search") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [detail], nextCursor: null, hasMore: false, mode: "fixture" } };
      if (request.method === "skills.detail") return { method: request.method, requestId: request.requestId, ok: true, result: detail };
      if (request.method === "skills.install") return { method: request.method, requestId: request.requestId, ok: true, result: { id: "op-1", slug: detail.slug, action: "install", state: "running", progress: 25, phase: "validating" } };
      return { method: request.method, requestId: request.requestId, ok: true, result: { id: "op-1", slug: detail.slug, action: "install", state: "succeeded", progress: 100, phase: "complete" } };
    });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(await screen.findByRole("button", { name: "安装 命令运行器" }));
    expect(await screen.findByRole("dialog", { name: "确认安装命令运行器" })).toHaveTextContent("高风险");
    expect(screen.getByText("执行 Git 命令")).toBeVisible();
    expect(screen.getByRole("button", { name: "确认安装" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "我已了解高风险权限" }));
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "skills.install",
      params: { slug: detail.slug, confirmation: { permissionFingerprint: "permission-hash", acceptedRisk: "high" } },
    })));
    await vi.waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100"));
  });

  it("renders an empty result without mixing Plugin or MCP entries", async () => {
    const invoke = vi.fn(async (request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: { items: [], nextCursor: null, hasMore: false, mode: "fixture" } }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    expect(await screen.findByText("没有匹配的免费技能")).toBeVisible();
    expect(screen.queryByText("Plugin")).not.toBeInTheDocument();
    expect(screen.queryByText("MCP")).not.toBeInTheDocument();
  });

  it("shows USB-installed Skills independently from the remote catalog", async () => {
    const installed = { ...detail, installedVersion: detail.version, enabled: true };
    const invoke = vi.fn(async (request: any) => ({
      method: request.method, requestId: request.requestId, ok: true,
      result: request.method === "skills.installed" ? [installed] : { items: [], nextCursor: null, hasMore: false, mode: "fixture" },
    }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(screen.getByRole("tab", { name: "已安装" }));
    expect(await screen.findByText("命令运行器")).toBeVisible();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "skills.installed" }));
  });

  it("ignores stale search responses and unlocks a failed operation", async () => {
    let resolveOld!: (value: any) => void;
    const old = new Promise((resolve) => { resolveOld = resolve; });
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.search" && request.params.query === "") return old;
      if (request.method === "skills.search") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [{ ...detail, name: "新结果" }], nextCursor: null, hasMore: false, mode: "fixture" } };
      if (request.method === "skills.detail") return { method: request.method, requestId: request.requestId, ok: true, result: detail };
      if (request.method === "skills.install") return { method: request.method, requestId: request.requestId, ok: true, result: { id: "failed-op", slug: detail.slug, action: "install", state: "running", progress: 20, phase: "downloading" } };
      throw new Error("offline");
    });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.change(screen.getByLabelText("搜索免费技能"), { target: { value: "new" } });
    expect(await screen.findByText("新结果")).toBeVisible();
    resolveOld({ method: "skills.search", requestId: "old", ok: true, result: { items: [{ ...detail, name: "旧结果" }], nextCursor: null, hasMore: false, mode: "fixture" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("旧结果")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "安装 新结果" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "我已了解高风险权限" }));
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
    expect(await screen.findByText("失败，可重试")).toBeVisible();
    expect(screen.getByRole("button", { name: "安装 新结果" })).not.toBeDisabled();
  });
});
