// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";

import { SkillManager } from "../src/features/skills/SkillManager";

afterEach(() => { cleanup(); delete window.uclaw; });

const detail = {
  slug: "command-runner", name: "命令运行器", description: "运行批准命令", version: "1.0.0",
  pricingType: "free", enabled: false, installedVersion: null, updateAvailable: false,
  source: { provider: "skillhub", url: "https://api.skillhub.cn/api/v1/skills/command-runner" },
  permissions: [{ kind: "command", access: "execute", target: "git", risk: "high", reason: "执行 Git 命令" }],
  permissionFingerprint: "permission-hash", identityFingerprint: "a".repeat(64), risk: "high", mode: "fixture", categories: ["developer-tools"],
  manifest: { kind: "skill", id: "command-runner", version: "1.0.0", entry: "SKILL.md" },
  ownerName: "U-Claw", downloads: 879, stars: 4, requiresKey: true,
  readme: "---\nname: command-runner\n---\n\n# 命令运行器\n\n安全执行命令。",
};

const response = (request: any, result: unknown) => ({ method: request.method, requestId: request.requestId, ok: true, result });
const failure = (request: any, message: string) => ({ method: request.method, requestId: request.requestId, ok: false, error: { code: "UNAVAILABLE", message, retryable: true, recoveryActions: ["retry"], causeDetails: {} } });
const runtimeItem = {
  id: "command-runner", name: "命令运行器", description: "运行批准命令", source: "workspace", bundled: false,
  disabled: false, eligible: false, modelVisible: false, userInvocable: true, commandVisible: false,
  availability: "missing-dependency", missing: { bins: ["git"], anyBins: ["node", "bun"], env: ["API_KEY"], config: ["tools.exec"], os: ["win32"] },
  conflicts: ["portable-bundled", "workspace-installed"],
};
const curator = {
  lastAttemptAtMs: 1, lastSuccessAtMs: 1, lastError: null, counts: { active: 1, stale: 1, archived: 1 },
  skills: [
    { skillFile: "one/SKILL.md", skillKey: "one", skillName: "One", state: "active", pinned: false, createdAtMs: 1, stateChangedAtMs: 1, lastUsedAtMs: 1, useCount: 2, archivedReason: null },
    { skillFile: "old/SKILL.md", skillKey: "old", skillName: "Old", state: "archived", pinned: true, createdAtMs: 1, stateChangedAtMs: 1, lastUsedAtMs: null, useCount: 0, archivedReason: "unused" },
  ],
  overlaps: [{ left: "one", right: "old", score: 0.84 }],
};
const proposalRecord = {
  schema: "openclaw.skill-workshop.proposal.v1", id: "proposal-1", kind: "create", status: "pending",
  title: "QA Skill", description: "Quality", createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z",
  createdBy: "gateway", origin: { agentId: "main", sessionKey: "agent:main:qa", runId: "run-1", messageId: "message-1" },
  proposedVersion: "v1", draftFile: "PROPOSAL.md", draftHash: "a".repeat(64),
  target: { skillName: "qa", skillKey: "qa", skillDir: "/workspace/skills/qa", skillFile: "/workspace/skills/qa/SKILL.md", source: "workspace" },
  scan: { state: "failed", scannedAt: "2026-08-12T00:00:00.000Z", critical: 1, warn: 2, info: 3, findings: [{ ruleId: "unsafe-exec", severity: "critical", file: "SKILL.md", line: 12, message: "Unsafe command", evidence: "exec rm" }] },
};
const inspected = {
  record: proposalRecord,
  content: "# QA",
};
const manifest = { schema: "openclaw.skill-workshop.proposals-manifest.v1", updatedAt: "2026-08-12T00:00:00.000Z", proposals: [{ id: "proposal-1", kind: "create", status: "pending", title: "QA Skill", description: "Quality", skillName: "qa", skillKey: "qa", createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z", scanState: "failed" }] };

const renderPublicInstalledSkills = () => {
  render(<SkillManager publicView />);
  fireEvent.click(screen.getByRole("tab", { name: "我的技能" }));
};

describe("SkillManager", () => {
  it("keeps marketplace loading, list, and pagination inside the bounded results region", async () => {
    let resolveSearch!: (value: ReturnType<typeof response>) => void;
    const invoke = vi.fn(() => new Promise<ReturnType<typeof response>>((resolve) => {
      resolveSearch = resolve;
    }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager publicView />);

    const library = screen.getByLabelText("技能库");
    const manager = screen.getByLabelText("技能管理");
    const results = screen.getByRole("region", { name: "技能搜索结果" });
    const toolbar = manager.querySelector(".skill-toolbar");
    expect(library).toContainElement(manager);
    expect(toolbar?.parentElement).toBe(results.parentElement);
    expect(toolbar?.nextElementSibling).toBe(results);
    expect(results).toContainElement(screen.getByText("正在加载免费技能"));

    resolveSearch(response({ method: "skills.search", requestId: "marketplace-list" }, {
      items: Array.from({ length: 40 }, (_, index) => ({ ...detail, slug: `skill-${index}`, name: `Skill ${index}` })),
      nextCursor: "page-2",
      hasMore: true,
      mode: "live",
    }));
    expect(await screen.findByText("Skill 39")).toBeVisible();
    expect(results).toContainElement(screen.getByLabelText("免费技能列表"));
    expect(results).toContainElement(screen.getByRole("button", { name: "加载更多技能" }));
  });

  it("keeps the empty marketplace in the results row directly after its toolbar", async () => {
    const invoke = vi.fn(async (request: any) => response(request, { items: [], nextCursor: null, hasMore: false, mode: "live" }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager publicView />);

    expect(await screen.findByText("没有匹配的免费技能")).toBeVisible();
    const manager = screen.getByLabelText("技能管理");
    const results = screen.getByRole("region", { name: "技能搜索结果" });
    expect(screen.getByRole("tablist", { name: "技能库视图" }).nextElementSibling).toBe(manager);
    expect(manager.querySelector(".skill-toolbar")?.nextElementSibling).toBe(results);
    expect(results.childElementCount).toBe(1);
    expect(results.firstElementChild).toHaveClass("skill-state");
  });

  it("keeps marketplace errors inside the results region directly after its toolbar", async () => {
    const invoke = vi.fn(async () => { throw new Error("offline"); });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager publicView />);

    const manager = screen.getByLabelText("技能管理");
    const results = screen.getByRole("region", { name: "技能搜索结果" });
    const error = await screen.findByRole("alert");
    expect(manager.querySelector(".skill-toolbar")?.nextElementSibling).toBe(results);
    expect(results).toContainElement(error);
  });

  it("opens the public Skill library on the marketplace and keeps installed Skills in a separate tab", async () => {
    const installed = { ...detail, installedVersion: detail.version, enabled: true, source: { provider: "openclaw", origin: "workspace" } };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.search") return response(request, { items: [detail], nextCursor: null, hasMore: false, mode: "fixture" });
      if (request.method === "skills.detail") return response(request, detail);
      if (request.method === "skills.installed") return response(request, [installed]);
      if (request.method === "skills.runtime-status") return response(request, { workspaceDir: "w", managedSkillsDir: "m", skills: [runtimeItem] });
      throw new Error(`unexpected ${request.method}`);
    });
    window.uclaw = { skills: { invoke } } as any;

    render(<SkillManager publicView />);

    expect(await screen.findByRole("heading", { name: "技能商城" })).toBeVisible();
    expect(screen.getByText("命令运行器")).toBeVisible();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "skills.search", params: { query: "", category: null, cursor: null, pageSize: 40, sort: "score" },
    }));
    expect(screen.getByLabelText("API Key 要求")).toHaveValue("all");
    expect(screen.getByLabelText("技能排序")).toHaveValue("score");
    fireEvent.click(screen.getByRole("button", { name: "查看详情 命令运行器" }));
    const marketplaceDetail = await screen.findByRole("dialog", { name: "技能详情 命令运行器" });
    expect(marketplaceDetail).toHaveTextContent("U-Claw");
    expect(marketplaceDetail).toHaveTextContent("879");
    expect(within(marketplaceDetail).getByRole("heading", { name: "命令运行器" })).toBeVisible();
    fireEvent.click(within(marketplaceDetail).getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("tab", { name: "我的技能" }));
    expect(await screen.findByRole("heading", { name: "Skill" })).toBeVisible();
    expect(screen.getByText("已安装")).toBeVisible();
  });

  it("keeps catalog presentation metadata when the detail response omits it", async () => {
    const logoUrl = "https://cloudcache.tencent-cloud.com/qcloud/ui/static/command-runner.png";
    const catalogItem = { ...detail, logoUrl, ownerName: "商城作者", downloads: 321, stars: 9, requiresKey: true };
    const sparseDetail = { ...detail, logoUrl: null, ownerName: undefined, downloads: undefined, stars: undefined, requiresKey: undefined };
    const invoke = vi.fn(async (request: any) => request.method === "skills.detail"
      ? response(request, sparseDetail)
      : response(request, { items: [catalogItem], nextCursor: null, hasMore: false, mode: "live" }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager publicView />);

    fireEvent.click(await screen.findByRole("button", { name: "打开技能详情 命令运行器" }));

    const drawer = await screen.findByRole("dialog", { name: "技能详情 命令运行器" });
    expect(within(drawer).getByRole("img", { name: "命令运行器 Logo" })).toHaveAttribute("src", logoUrl);
    expect(drawer).toHaveTextContent("商城作者");
    expect(drawer).toHaveTextContent("321");
    expect(drawer).toHaveTextContent("9");
    expect(drawer).toHaveTextContent("API Key");
  });

  it("opens marketplace details from a keyboard-focusable identity and prevents duplicate detail requests while loading", async () => {
    let resolveDetail!: (value: any) => void;
    const pendingDetail = new Promise((resolve) => { resolveDetail = resolve; });
    const invoke = vi.fn(async (request: any) => request.method === "skills.detail"
      ? pendingDetail
      : response(request, { items: [detail], nextCursor: null, hasMore: false, mode: "live" }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager publicView />);

    const identity = await screen.findByRole("button", { name: "打开技能详情 命令运行器" });
    expect(identity).toHaveAttribute("type", "button");
    identity.focus();
    expect(identity).toHaveFocus();
    fireEvent.click(identity);

    expect(await screen.findByText("正在读取详情")).toBeVisible();
    expect(identity).toBeDisabled();
    expect(screen.getByRole("button", { name: "安装 命令运行器" })).toBeDisabled();
    fireEvent.click(identity);
    expect(invoke.mock.calls.filter(([request]) => request.method === "skills.detail")).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "skills.detail",
      params: { slug: detail.slug, expectedVersion: detail.version },
    }));

    resolveDetail(response({ method: "skills.detail", requestId: "detail" }, detail));
    expect(await screen.findByRole("dialog", { name: "技能详情 命令运行器" })).toBeVisible();
  });

  it("shows detail failures above the marketplace list and restores its detail actions", async () => {
    const invoke = vi.fn(async (request: any) => request.method === "skills.detail"
      ? failure(request, "README 暂时不可用")
      : response(request, { items: [detail], nextCursor: null, hasMore: false, mode: "live" }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager publicView />);

    const identity = await screen.findByRole("button", { name: "打开技能详情 命令运行器" });
    fireEvent.click(identity);

    const alert = await screen.findByRole("alert");
    const list = screen.getByLabelText("免费技能列表");
    expect(alert).toHaveTextContent("README 暂时不可用");
    expect(alert.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(identity).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "安装 命令运行器" })).not.toBeDisabled();
  });

  it("debounces marketplace search and sends category and sort through IPC", async () => {
    const invoke = vi.fn(async (request: any) => response(request, { items: [detail], nextCursor: null, hasMore: false, mode: "fixture" }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager publicView />);
    await screen.findByText("命令运行器");
    invoke.mockClear();

    fireEvent.change(screen.getByLabelText("搜索免费技能"), { target: { value: "command" } });
    expect(invoke).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "skills.search", params: expect.objectContaining({ query: "command", sort: "score" }),
    })), { timeout: 600 });
    fireEvent.change(screen.getByLabelText("技能分类"), { target: { value: "developer-tools" } });
    fireEvent.change(screen.getByLabelText("技能排序"), { target: { value: "downloads" } });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "skills.search", params: expect.objectContaining({ category: "developer-tools", sort: "downloads" }),
    })));
  });

  it("shows loading while a category replacement is pending", async () => {
    let resolveFiltered!: (value: ReturnType<typeof response>) => void;
    const filtered = { ...detail, slug: "office-helper", name: "办公助手" };
    const invoke = vi.fn(async (request: any) => {
      if (request.params.category === "office-efficiency") {
        return new Promise<ReturnType<typeof response>>((resolve) => { resolveFiltered = resolve; });
      }
      return response(request, { items: [detail], nextCursor: null, hasMore: false, mode: "live" });
    });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager publicView />);

    expect(await screen.findByText("命令运行器")).toBeVisible();
    fireEvent.change(screen.getByLabelText("技能分类"), { target: { value: "office-efficiency" } });
    const results = screen.getByRole("region", { name: "技能搜索结果" });
    await vi.waitFor(() => expect(results).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByText("正在加载免费技能")).toBeVisible();
    expect(screen.queryByLabelText("免费技能列表")).not.toBeInTheDocument();
    expect(screen.queryByText("命令运行器")).not.toBeInTheDocument();

    resolveFiltered(response({ method: "skills.search", requestId: "filtered" }, {
      items: [filtered], nextCursor: null, hasMore: false, mode: "live",
    }));
    expect(await screen.findByText("办公助手")).toBeVisible();
    expect(results).toHaveAttribute("aria-busy", "false");
  });

  it("filters API Key requirements locally and sanitizes marketplace README links", async () => {
    const noKey = { ...detail, slug: "plain-skill", name: "普通技能", requiresKey: false };
    const unknownKey = { ...detail, slug: "unknown-key-skill", name: "要求未知技能", requiresKey: undefined };
    const unsafeDetail = { ...detail, readme: "# 命令运行器\n\n[危险链接](javascript:alert(1))\n\n![远程追踪图](https://tracker.example/pixel.png)" };
    const invoke = vi.fn(async (request: any) => request.method === "skills.detail"
      ? response(request, unsafeDetail)
      : response(request, { items: [detail, noKey, unknownKey], nextCursor: null, hasMore: false, mode: "fixture" }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager publicView />);
    await screen.findByText("普通技能");
    invoke.mockClear();

    fireEvent.change(screen.getByLabelText("API Key 要求"), { target: { value: "required" } });
    expect(screen.getByText("命令运行器")).toBeVisible();
    expect(screen.queryByText("普通技能")).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("API Key 要求"), { target: { value: "not-required" } });
    expect(screen.getByText("普通技能")).toBeVisible();
    expect(screen.queryByText("命令运行器")).not.toBeInTheDocument();
    expect(screen.queryByText("要求未知技能")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("API Key 要求"), { target: { value: "required" } });

    fireEvent.click(screen.getByRole("button", { name: "查看详情 命令运行器" }));
    const drawer = await screen.findByRole("dialog", { name: "技能详情 命令运行器" });
    expect(within(drawer).getByText("危险链接")).not.toHaveAttribute("href");
    expect(within(drawer).queryByRole("img", { name: "远程追踪图" })).not.toBeInTheDocument();
  });

  it("routes marketplace drawer installation through permission confirmation", async () => {
    const invoke = vi.fn(async (request: any) => request.method === "skills.detail"
      ? response(request, detail)
      : response(request, { items: [detail], nextCursor: null, hasMore: false, mode: "fixture" }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager publicView />);
    fireEvent.click(await screen.findByRole("button", { name: "查看详情 命令运行器" }));
    const drawer = await screen.findByRole("dialog", { name: "技能详情 命令运行器" });

    fireEvent.click(within(drawer).getByRole("button", { name: "安装" }));

    const confirmation = await screen.findByRole("dialog", { name: "确认安装命令运行器" });
    expect(within(confirmation).getByRole("button", { name: "确认安装" })).toBeDisabled();
    expect(invoke.mock.calls.some(([request]) => request.method === "skills.install")).toBe(false);
  });

  it("locks every marketplace detail trigger while one detail request is pending", async () => {
    let resolveFirst!: (value: any) => void;
    const firstDetail = new Promise((resolve) => { resolveFirst = resolve; });
    const second = { ...detail, slug: "second-skill", name: "第二技能" };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.search") return response(request, { items: [detail, second], nextCursor: null, hasMore: false, mode: "fixture" });
      if (request.method === "skills.detail") return firstDetail;
      throw new Error(`unexpected ${request.method}`);
    });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager publicView />);

    fireEvent.click(await screen.findByRole("button", { name: "打开技能详情 命令运行器" }));

    for (const name of ["打开技能详情 命令运行器", "查看详情 命令运行器", "安装 命令运行器", "打开技能详情 第二技能", "查看详情 第二技能", "安装 第二技能"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(screen.getAllByText("正在读取详情")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "打开技能详情 第二技能" }));
    expect(invoke.mock.calls.filter(([request]) => request.method === "skills.detail")).toHaveLength(1);

    resolveFirst(response({ method: "skills.detail", requestId: "first-detail" }, detail));
    expect(await screen.findByRole("dialog", { name: "技能详情 命令运行器" })).toBeVisible();
    expect(screen.getByRole("button", { name: "打开技能详情 第二技能" })).not.toBeDisabled();
  });

  it("renders the public installed Skill workbench with runtime status and filters", async () => {
    const installed = { ...detail, installedVersion: detail.version, enabled: true, source: { provider: "openclaw", origin: "workspace" } };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.installed") return response(request, [installed]);
      if (request.method === "skills.runtime-status") return response(request, { workspaceDir: "hidden", managedSkillsDir: "hidden", skills: [runtimeItem] });
      if (request.method === "skills.local-detail") return response(request, { slug: installed.slug, name: installed.name, description: installed.description, markdown: "---\nname: command-runner\ndescription: 运行批准命令\n---\n\n# 命令运行器\n\n- 安全执行\n- 记录结果\n\n| 项目 | 内容 |\n| --- | --- |\n| 依赖 | git |\n" });
      throw new Error(`unexpected ${request.method}`);
    });
    window.uclaw = { skills: { invoke } } as any;
    renderPublicInstalledSkills();

    expect(await screen.findByRole("heading", { name: "Skill" })).toBeVisible();
    expect(screen.getByText("已安装")).toBeVisible();
    expect(document.querySelector(".skill-status.missing-dependency")).toHaveTextContent("缺少依赖");
    expect(screen.getByRole("button", { name: "发现更多 Skill" })).toBeVisible();
    expect(screen.getByRole("button", { name: "导入 Skill" })).toBeVisible();
    expect(screen.queryByText("Curator")).not.toBeInTheDocument();
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索本地 Skill"), { target: { value: "not-found" } });
    expect(screen.getByText("没有符合条件的 Skill")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    const identityButton = screen.getByRole("button", { name: "打开 命令运行器详情" });
    expect(identityButton.tagName).toBe("BUTTON");
    expect(within(identityButton).getByRole("img", { name: "命令运行器 Skill 图标" })).toBeVisible();
    expect(identityButton.querySelector("i")).not.toBeInTheDocument();
    fireEvent.click(identityButton);
    const drawer = await screen.findByRole("dialog", { name: "Skill 详情 命令运行器" });
    expect(drawer).toHaveTextContent("git");
    expect(drawer.querySelector(".skill-drawer-body")).toBeInTheDocument();
    expect(drawer).toHaveTextContent("安全执行");
    expect(drawer).not.toHaveTextContent("name: command-runner");
    expect(within(drawer).getByRole("heading", { name: "命令运行器", level: 1 })).toBeVisible();
    expect(within(drawer).getByRole("table")).toBeVisible();
    expect(drawer.querySelector("footer")).toContainElement(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("button", { name: "查看修复建议" })).not.toBeInTheDocument();
  });

  it("shows the backend error when a local Skill enable change fails", async () => {
    const installed = { ...detail, installedVersion: "local", version: "local", enabled: false, source: { provider: "openclaw", origin: "workspace" } };
    const availableRuntime = { ...runtimeItem, disabled: true, eligible: true, availability: "disabled", missing: { bins: [], anyBins: [], env: [], config: [], os: [] }, conflicts: [] };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.installed") return response(request, [installed]);
      if (request.method === "skills.runtime-status") return response(request, { workspaceDir: "w", managedSkillsDir: "m", skills: [availableRuntime] });
      if (request.method === "skills.set-enabled") return response(request, { id: "enable-1", slug: installed.slug, action: "enable", state: "failed", progress: 70, phase: "failed", error: "OpenClaw Skill readback mismatch." });
      throw new Error(`unexpected ${request.method}`);
    });
    window.uclaw = { skills: { invoke } } as any;
    renderPublicInstalledSkills();

    fireEvent.click(await screen.findByRole("switch", { name: "启用 命令运行器" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("OpenClaw Skill readback mismatch.");
  });

  it("shows a success toast when a local Skill enable change succeeds", async () => {
    let enabled = false;
    const installed = () => ({ ...detail, installedVersion: "local", version: "local", enabled, source: { provider: "openclaw", origin: "workspace" } });
    const availableRuntime = { ...runtimeItem, disabled: true, eligible: true, availability: "disabled", missing: { bins: [], anyBins: [], env: [], config: [], os: [] }, conflicts: [] };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.installed") return response(request, [installed()]);
      if (request.method === "skills.runtime-status") return response(request, { workspaceDir: "w", managedSkillsDir: "m", skills: [availableRuntime] });
      if (request.method === "skills.set-enabled") {
        enabled = true;
        return response(request, { id: "enable-1", slug: detail.slug, action: "enable", state: "succeeded", progress: 100, phase: "complete" });
      }
      throw new Error(`unexpected ${request.method}`);
    });
    window.uclaw = { skills: { invoke } } as any;
    renderPublicInstalledSkills();

    fireEvent.click(await screen.findByRole("switch", { name: "启用 命令运行器" }));

    expect(await screen.findByRole("status")).toHaveTextContent("命令运行器已启用");
  });

  it("shows the backend message when SKILL.md cannot be read", async () => {
    const installed = { ...detail, installedVersion: "local", version: "local", enabled: true, source: { provider: "openclaw", origin: "workspace" } };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.installed") return response(request, [installed]);
      if (request.method === "skills.runtime-status") return response(request, { workspaceDir: "w", managedSkillsDir: "m", skills: [{ ...runtimeItem, availability: "available", missing: { bins: [], anyBins: [], env: [], config: [], os: [] }, conflicts: [] }] });
      if (request.method === "skills.local-detail") return failure(request, "Workspace Skill not found.");
      throw new Error(`unexpected ${request.method}`);
    });
    window.uclaw = { skills: { invoke } } as any;
    renderPublicInstalledSkills();

    fireEvent.click(await screen.findByRole("button", { name: "查看 命令运行器" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Workspace Skill not found.");
  });

  it("opens the fixed hub and prepares a selected ZIP before confirmation", async () => {
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.installed") return response(request, []);
      if (request.method === "skills.runtime-status") return response(request, { workspaceDir: "w", managedSkillsDir: "m", skills: [] });
      if (request.method === "skills.open-hub") return response(request, { opened: true });
      if (request.method === "skills.import-select") return response(request, { token: "fixture-selection-token-1", fileName: "useful.zip", sizeBytes: 1024 });
      if (request.method === "skills.import-prepare") return response(request, { ...detail, risk: "high" });
      throw new Error(`unexpected ${request.method}`);
    });
    window.uclaw = { skills: { invoke } } as any;
    renderPublicInstalledSkills();
    await screen.findByText("尚未安装 Skill");
    fireEvent.click(screen.getByRole("button", { name: "发现更多 Skill" }));
    fireEvent.click(screen.getByRole("button", { name: "导入 Skill" }));
    expect(await screen.findByRole("dialog", { name: "确认导入 命令运行器" })).toHaveTextContent("高风险");
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "skills.open-hub", params: {} }));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "skills.import-prepare", params: { token: "fixture-selection-token-1" } }));
  });

  it("shows ZIP validation failures while the workbench data remains available", async () => {
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.installed") return response(request, []);
      if (request.method === "skills.runtime-status") return response(request, { workspaceDir: "w", managedSkillsDir: "m", skills: [] });
      if (request.method === "skills.import-select") return response(request, { token: "fixture-selection-token-1", fileName: "broken.zip", sizeBytes: 1024 });
      if (request.method === "skills.import-prepare") return failure(request, "Skill ZIP frontmatter 缺少 version");
      throw new Error(`unexpected ${request.method}`);
    });
    window.uclaw = { skills: { invoke } } as any;
    renderPublicInstalledSkills();
    await screen.findByText("尚未安装 Skill");

    fireEvent.click(screen.getByRole("button", { name: "导入 Skill" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Skill ZIP frontmatter 缺少 version");
    expect(screen.getByText("尚未安装 Skill")).toBeVisible();
  });

  it("polls a confirmed ZIP install through OpenClaw readback and refreshes the workbench", async () => {
    let installedReads = 0;
    const installed = { ...detail, installedVersion: detail.version, enabled: true, source: { provider: "openclaw", origin: "workspace" } };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.installed") return response(request, installedReads++ === 0 ? [] : [installed]);
      if (request.method === "skills.runtime-status") return response(request, { workspaceDir: "w", managedSkillsDir: "m", skills: installedReads > 1 ? [runtimeItem] : [] });
      if (request.method === "skills.import-select") return response(request, { token: "fixture-selection-token-1", fileName: "useful.zip", sizeBytes: 1024 });
      if (request.method === "skills.import-prepare") return response(request, { ...detail, risk: "high" });
      if (request.method === "skills.import-install") return response(request, { id: "zip-op-1", slug: detail.slug, action: "install", state: "queued", progress: 0, phase: "queued" });
      if (request.method === "skills.operation") return response(request, { id: "zip-op-1", slug: detail.slug, action: "install", state: "succeeded", progress: 100, phase: "complete" });
      throw new Error(`unexpected ${request.method}`);
    });
    window.uclaw = { skills: { invoke } } as any;
    renderPublicInstalledSkills();
    await screen.findByText("尚未安装 Skill");

    fireEvent.click(screen.getByRole("button", { name: "导入 Skill" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "我已了解网络来源 Skill 的高风险" }));
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "skills.operation", params: { operationId: "zip-op-1" },
    })));
    expect(await screen.findByText("命令运行器")).toBeVisible();
    expect(screen.getByText("命令运行器 安装成功，OpenClaw 已完成读回")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭操作提示" }));
    expect(screen.queryByText("命令运行器 安装成功，OpenClaw 已完成读回")).not.toBeInTheDocument();
    expect(invoke.mock.calls.filter(([request]) => request.method === "skills.installed")).toHaveLength(2);
  });

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
      params: {
        slug: detail.slug,
        expectedVersion: detail.version,
        confirmation: {
          permissionFingerprint: "permission-hash",
          identityFingerprint: "a".repeat(64),
          acceptedRisk: "high",
        },
      },
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

  it("reads installed and OpenClaw runtime state after a successful enable change", async () => {
    const installed = { ...detail, installedVersion: detail.version, enabled: true };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.search") return response(request, { items: [], nextCursor: null, hasMore: false, mode: "fixture" });
      if (request.method === "skills.installed") return response(request, [installed]);
      if (request.method === "skills.set-enabled") return response(request, { id: "disable-1", slug: detail.slug, action: "disable", state: "running", progress: 50, phase: "persisting" });
      if (request.method === "skills.operation") return response(request, { id: "disable-1", slug: detail.slug, action: "disable", state: "succeeded", progress: 100, phase: "complete" });
      if (request.method === "skills.runtime-status") return response(request, { workspaceDir: "workspace", managedSkillsDir: "managed", skills: [runtimeItem] });
      throw new Error(`unexpected ${request.method}`);
    });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(screen.getByRole("tab", { name: "已安装" }));
    fireEvent.click(await screen.findByRole("switch", { name: "禁用 命令运行器" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "skills.runtime-status" })));
    expect(invoke.mock.calls.filter(([request]) => request.method === "skills.installed").length).toBeGreaterThan(1);
  });

  it("enables a local workspace Skill without loading remote detail or asking for risk confirmation", async () => {
    const installed = {
      ...detail,
      slug: "local-skill",
      name: "本地技能",
      installedVersion: "local",
      version: "local",
      enabled: false,
      source: { provider: "openclaw", origin: "workspace" },
      permissions: [],
      permissionFingerprint: "local",
      risk: "low",
    };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.search") return response(request, { items: [], nextCursor: null, hasMore: false, mode: "fixture" });
      if (request.method === "skills.installed") return response(request, [installed]);
      if (request.method === "skills.set-enabled") return response(request, { id: "enable-local", slug: installed.slug, action: "enable", state: "failed", progress: 5, phase: "failed" });
      throw new Error(`unexpected ${request.method}`);
    });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(screen.getByRole("tab", { name: "已安装" }));
    fireEvent.click(await screen.findByRole("switch", { name: "启用 本地技能" }));

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "skills.set-enabled",
      params: { slug: installed.slug, enabled: true, confirmation: null },
    })));
    expect(invoke.mock.calls.some(([request]) => request.method === "skills.detail")).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("confirms a SkillHub enable from the installed permission snapshot without loading remote detail", async () => {
    const installed = { ...detail, installedVersion: detail.version, enabled: false };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.search") return response(request, { items: [], nextCursor: null, hasMore: false, mode: "fixture" });
      if (request.method === "skills.installed") return response(request, [installed]);
      if (request.method === "skills.set-enabled") return response(request, { id: "enable-skillhub", slug: installed.slug, action: "enable", state: "failed", progress: 5, phase: "failed" });
      throw new Error(`unexpected ${request.method}`);
    });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(screen.getByRole("tab", { name: "已安装" }));
    fireEvent.click(await screen.findByRole("switch", { name: "启用 命令运行器" }));

    const dialog = await screen.findByRole("dialog", { name: "确认启用命令运行器" });
    expect(dialog).toHaveTextContent("执行 Git 命令");
    expect(invoke.mock.calls.some(([request]) => request.method === "skills.detail")).toBe(false);
    expect(screen.getByRole("button", { name: "确认启用" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "我已了解高风险权限" }));
    fireEvent.click(screen.getByRole("button", { name: "确认启用" }));

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "skills.set-enabled",
      params: {
        slug: installed.slug,
        enabled: true,
        confirmation: { permissionFingerprint: installed.permissionFingerprint, acceptedRisk: installed.risk },
      },
    })));
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

  it("sends category filters and opens detail independently from installation", async () => {
    const invoke = vi.fn(async (request: any) => request.method === "skills.detail"
      ? response(request, detail)
      : response(request, { items: [detail], nextCursor: null, hasMore: false, mode: "fixture" }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.change(await screen.findByLabelText("技能分类"), { target: { value: "developer-tools" } });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "skills.search", params: expect.objectContaining({ category: "developer-tools" }),
    })));
    fireEvent.click(await screen.findByRole("button", { name: "查看详情 命令运行器" }));
    const dialog = await screen.findByRole("dialog", { name: "技能详情 命令运行器" });
    expect(dialog).toHaveTextContent("developer-tools");
    expect(dialog).toHaveTextContent("git");
    expect(invoke).not.toHaveBeenCalledWith(expect.objectContaining({ method: "skills.install" }));
  });

  it("derives category options from catalog items without inventing categories", async () => {
    const writing = { ...detail, slug: "writer", name: "写作助手", categories: ["writing"] };
    const invoke = vi.fn(async (request: any) => response(request, { items: [writing], nextCursor: null, hasMore: false, mode: "live" }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    expect(await screen.findByRole("option", { name: "writing" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "自动化" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("技能分类"), { target: { value: "writing" } });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "skills.search", params: expect.objectContaining({ category: "writing" }),
    })));
  });

  it("shows official Chinese marketplace categories while sending their stable SkillHub keys", async () => {
    const invoke = vi.fn(async (request: any) => response(request, { items: [detail], nextCursor: null, hasMore: false, mode: "live" }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager publicView />);

    expect(await screen.findByRole("option", { name: "付费技能" })).toBeDisabled();
    expect(await screen.findByRole("option", { name: "办公效率" })).toHaveValue("office-efficiency");
    expect(screen.getByRole("option", { name: "AI 智能体" })).toHaveValue("ai-agent");
    fireEvent.change(screen.getByLabelText("技能分类"), { target: { value: "office-efficiency" } });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "skills.search", params: expect.objectContaining({ category: "office-efficiency" }),
    })));
  });

  it("shows authoritative runtime missing requirements, conflicts, and source", async () => {
    const invoke = vi.fn(async (request: any) => response(request, {
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [runtimeItem],
    }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(screen.getByRole("tab", { name: "运行状态" }));
    const row = await screen.findByRole("article", { name: "运行状态 命令运行器" });
    expect(row).toHaveTextContent("缺少依赖");
    expect(row).toHaveTextContent("git");
    expect(row).toHaveTextContent("node / bun");
    expect(row).toHaveTextContent("API_KEY");
    expect(row).toHaveTextContent("tools.exec");
    expect(row).toHaveTextContent("win32");
    expect(row).toHaveTextContent("portable-bundled");
    expect(row).toHaveTextContent("workspace");
  });

  it("renders duplicate runtime ids from different sources without duplicate React keys", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const invoke = vi.fn(async (request: any) => response(request, {
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills",
      skills: [runtimeItem, { ...runtimeItem, source: "workspace", bundled: false }],
    }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(screen.getByRole("tab", { name: "运行状态" }));

    expect(await screen.findAllByRole("article", { name: "运行状态 命令运行器" })).toHaveLength(2);
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
    consoleError.mockRestore();
  });

  it("shows unknown state instead of enabled when OpenClaw did not return a local Skill", async () => {
    const invoke = vi.fn(async (request: any) => response(request, {
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills",
      skills: [{ ...runtimeItem, disabled: false, availability: "error", source: "workspace-installed" }],
    }));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(screen.getByRole("tab", { name: "运行状态" }));

    const row = await screen.findByRole("article", { name: "运行状态 命令运行器" });
    expect(row).toHaveTextContent("状态未知");
    expect(row).not.toHaveTextContent("已启用");
  });

  it("runs every curator action, reloads status, and exposes failures", async () => {
    let failRestore = false;
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.curator-status") return response(request, curator);
      if (request.method === "skills.curator-action" && request.params.action === "restore" && failRestore) return failure(request, "恢复失败");
      return response(request, curator.skills[0]);
    });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(screen.getByRole("tab", { name: "Curator" }));
    expect(await screen.findByText("活跃 1")).toBeVisible();
    expect(screen.getByText("one ↔ old · 84%")).toBeVisible();
    const pin = screen.getByRole("button", { name: "固定 One" });
    fireEvent.click(pin);
    await vi.waitFor(() => expect(pin).not.toBeDisabled());
    const unpin = screen.getByRole("button", { name: "取消固定 Old" });
    fireEvent.click(unpin);
    await vi.waitFor(() => expect(unpin).not.toBeDisabled());
    failRestore = true;
    fireEvent.click(screen.getByRole("button", { name: "恢复 Old" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("恢复失败");
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "skills.curator-action", params: { skill: "one", action: "pin" } }));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "skills.curator-action", params: { skill: "old", action: "unpin" } }));
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([request]) => request.method === "skills.curator-status").length).toBeGreaterThan(1));
  });

  it("supports complete proposal authoring, revision, review, and visible scan findings", async () => {
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.proposals-list") return response(request, manifest);
      if (["skills.proposal-inspect", "skills.proposal-create", "skills.proposal-update", "skills.proposal-revise"].includes(request.method)) return response(request, inspected);
      if (request.method === "skills.proposal-request-revision") return response(request, { runId: "run-1", status: "started" });
      return response(request, proposalRecord);
    });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(screen.getByRole("tab", { name: "Proposals" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看提案 QA Skill" }));
    expect(await screen.findByText("Critical 1")).toBeVisible();
    expect(screen.getByText("Unsafe command")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "新建提案" }));
    fireEvent.change(screen.getByLabelText("提案名称"), { target: { value: "new-skill" } });
    fireEvent.change(screen.getByLabelText("提案描述"), { target: { value: "New skill" } });
    fireEvent.change(screen.getByLabelText("提案内容"), { target: { value: "# New" } });
    fireEvent.click(screen.getByRole("button", { name: "创建提案" }));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "更新 Skill" })).not.toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "更新 Skill" }));
    fireEvent.change(screen.getByLabelText("Skill 名称"), { target: { value: "qa" } });
    fireEvent.change(screen.getByLabelText("更新内容"), { target: { value: "# QA v2" } });
    fireEvent.click(screen.getByRole("button", { name: "提交更新" }));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "提交修订" })).not.toBeDisabled());

    fireEvent.change(screen.getByLabelText("修订内容"), { target: { value: "# Revised" } });
    fireEvent.click(screen.getByRole("button", { name: "提交修订" }));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "请求修订" })).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("修订说明"), { target: { value: "Add tests" } });
    fireEvent.change(screen.getByLabelText("会话 Key"), { target: { value: "skill-session" } });
    fireEvent.click(screen.getByRole("button", { name: "请求修订" }));
    expect(await screen.findByText("run-1 · started")).toBeVisible();

    fireEvent.change(screen.getByLabelText("处置原因"), { target: { value: "reviewed" } });
    for (const [name, action] of [["应用提案", "apply"], ["拒绝提案", "reject"], ["隔离提案", "quarantine"]] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "skills.proposal-action", params: expect.objectContaining({ action }) })));
      await vi.waitFor(() => expect(screen.getByRole("button", { name })).not.toBeDisabled());
    }
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "skills.proposal-create" })));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "skills.proposal-update" }));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "skills.proposal-revise" }));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "skills.proposal-request-revision" }));
    for (const action of ["apply", "reject", "quarantine"]) expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "skills.proposal-action", params: expect.objectContaining({ action, reason: "reviewed" }) }));
  });

  it("serializes proposal actions and disables all proposal writes while pending", async () => {
    let resolveAction!: (value: any) => void;
    const pendingAction = new Promise((resolve) => { resolveAction = resolve; });
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.proposals-list") return response(request, manifest);
      if (request.method === "skills.proposal-inspect") return response(request, inspected);
      if (request.method === "skills.proposal-action") return pendingAction;
      return response(request, inspected);
    });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(screen.getByRole("tab", { name: "Proposals" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看提案 QA Skill" }));
    fireEvent.click(await screen.findByRole("button", { name: "应用提案" }));
    for (const name of ["新建提案", "更新 Skill", "提交修订", "请求修订", "应用提案", "拒绝提案", "隔离提案"]) expect(screen.getByRole("button", { name })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "拒绝提案" }));
    expect(invoke.mock.calls.filter(([request]) => request.method === "skills.proposal-action")).toHaveLength(1);
    resolveAction(response({ method: "skills.proposal-action", requestId: "action" }, proposalRecord));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "应用提案" })).not.toBeDisabled());
    expect(invoke.mock.calls.filter(([request]) => request.method === "skills.proposals-list").length).toBeGreaterThan(1);
    expect(invoke.mock.calls.filter(([request]) => request.method === "skills.proposal-inspect").length).toBeGreaterThan(1);
  });

  it("uses one synchronous guard for curator and every proposal mutation", async () => {
    let resolveMutation!: (value: any) => void;
    const pendingMutation = new Promise((resolve) => { resolveMutation = resolve; });
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.curator-status") return response(request, curator);
      if (request.method === "skills.proposals-list") return response(request, manifest);
      if (request.method === "skills.proposal-inspect") return response(request, inspected);
      if (request.method === "skills.curator-action") return pendingMutation;
      return response(request, inspected);
    });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(screen.getByRole("tab", { name: "Curator" }));
    const pin = await screen.findByRole("button", { name: "固定 One" });
    fireEvent.click(pin);
    fireEvent.click(pin);
    expect(invoke.mock.calls.filter(([request]) => request.method === "skills.curator-action")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "取消固定 Old" })).toBeDisabled();

    fireEvent.click(screen.getByRole("tab", { name: "Proposals" }));
    expect(await screen.findByRole("button", { name: "新建提案" })).toBeDisabled();
    resolveMutation(response({ method: "skills.curator-action", requestId: "curator" }, curator.skills[0]));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "新建提案" })).not.toBeDisabled());
  });

  it.each([
    ["skills.proposal-create", "创建提案"],
    ["skills.proposal-update", "提交更新"],
    ["skills.proposal-revise", "提交修订"],
    ["skills.proposal-request-revision", "请求修订"],
  ] as const)("blocks duplicate %s writes before React rerenders", async (method, buttonName) => {
    let resolveMutation!: (value: any) => void;
    const pendingMutation = new Promise((resolve) => { resolveMutation = resolve; });
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.proposals-list") return response(request, manifest);
      if (request.method === "skills.proposal-inspect") return response(request, inspected);
      if (request.method === method) return pendingMutation;
      return response(request, inspected);
    });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(screen.getByRole("tab", { name: "Proposals" }));
    await screen.findByRole("button", { name: "查看提案 QA Skill" });
    if (method === "skills.proposal-create") fireEvent.click(screen.getByRole("button", { name: "新建提案" }));
    if (method === "skills.proposal-update") fireEvent.click(screen.getByRole("button", { name: "更新 Skill" }));
    if (method === "skills.proposal-revise" || method === "skills.proposal-request-revision") {
      fireEvent.click(screen.getByRole("button", { name: "查看提案 QA Skill" }));
      await screen.findByLabelText("修订内容");
    }
    const button = screen.getByRole("button", { name: buttonName });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(invoke.mock.calls.filter(([request]) => request.method === method)).toHaveLength(1);
    resolveMutation(response({ method, requestId: "mutation" }, method === "skills.proposal-request-revision"
      ? { runId: "run-1", status: "started" }
      : inspected));
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([request]) => request.method === method)).toHaveLength(1));
  });

  it("keeps the newest proposal inspection when an older request finishes later", async () => {
    let resolveA!: (value: any) => void;
    const slowA = new Promise((resolve) => { resolveA = resolve; });
    const proposalB = { ...proposalRecord, id: "proposal-2", title: "B Skill", target: { ...proposalRecord.target, skillName: "b", skillKey: "b" } };
    const manifestAB = { ...manifest, proposals: [manifest.proposals[0], { ...manifest.proposals[0], id: "proposal-2", title: "B Skill", skillName: "b", skillKey: "b" }] };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.proposals-list") return response(request, manifestAB);
      if (request.method === "skills.proposal-inspect" && request.params.proposalId === "proposal-1") return slowA;
      if (request.method === "skills.proposal-inspect") return response(request, { record: proposalB, content: "# B" });
      return response(request, proposalRecord);
    });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(screen.getByRole("tab", { name: "Proposals" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看提案 QA Skill" }));
    fireEvent.click(screen.getByRole("button", { name: "查看提案 B Skill" }));
    expect(await screen.findByDisplayValue("# B")).toBeVisible();
    resolveA(response({ method: "skills.proposal-inspect", requestId: "a" }, inspected));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByLabelText("修订内容")).toHaveValue("# B");
  });

  it("does not overwrite a new proposal selection when an older disposition reads back", async () => {
    let resolveAction!: (value: any) => void;
    const pendingAction = new Promise((resolve) => { resolveAction = resolve; });
    const proposalB = { ...proposalRecord, id: "proposal-2", title: "B Skill", target: { ...proposalRecord.target, skillName: "b", skillKey: "b" } };
    const manifestAB = { ...manifest, proposals: [manifest.proposals[0], { ...manifest.proposals[0], id: "proposal-2", title: "B Skill", skillName: "b", skillKey: "b" }] };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "skills.proposals-list") return response(request, manifestAB);
      if (request.method === "skills.proposal-inspect") return response(request, request.params.proposalId === "proposal-2" ? { record: proposalB, content: "# B" } : inspected);
      if (request.method === "skills.proposal-action") return pendingAction;
      return response(request, proposalRecord);
    });
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(screen.getByRole("tab", { name: "Proposals" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看提案 QA Skill" }));
    fireEvent.click(await screen.findByRole("button", { name: "应用提案" }));
    fireEvent.click(screen.getByRole("button", { name: "查看提案 B Skill" }));
    expect(await screen.findByDisplayValue("# B")).toBeVisible();
    resolveAction(response({ method: "skills.proposal-action", requestId: "action" }, proposalRecord));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "应用提案" })).not.toBeDisabled());
    expect(screen.getByLabelText("修订内容")).toHaveValue("# B");
  });

  it("shows proposal response failures instead of silently returning", async () => {
    const invoke = vi.fn(async (request: any) => request.method === "skills.proposals-list"
      ? response(request, manifest)
      : request.method === "skills.proposal-inspect"
        ? response(request, inspected)
        : failure(request, "提案操作失败"));
    window.uclaw = { skills: { invoke } } as any;
    render(<SkillManager />);
    fireEvent.click(screen.getByRole("tab", { name: "Proposals" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看提案 QA Skill" }));
    fireEvent.click(await screen.findByRole("button", { name: "应用提案" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("提案操作失败");
  });
});
