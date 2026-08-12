import { expect, test, type Page } from "@playwright/test";

const servers = [
  {
    id: "docs", name: "Docs MCP", enabled: true, transport: "streamable-http",
    endpointHint: "mcp.example.com", authentication: { type: "bearer", configured: true, hint: "...1001" },
    status: "unavailable", capabilitySummary: { tools: 2, resources: 1, prompts: 0 },
    toolNames: ["search", "read"], resourceSchemes: ["docs"],
    lastError: { code: "UNAVAILABLE", message: "Runtime MCP RPC unavailable.", retryable: false, recoveryActions: [], causeDetails: {} },
  },
  {
    id: "local", name: "Local MCP", enabled: true, transport: "stdio", executableId: "node",
    risk: "none", status: "unavailable", capabilitySummary: { tools: 0, resources: 0, prompts: 0 },
    toolNames: [], resourceSchemes: [],
  },
] as const;

async function installMcpBridge(page: Page) {
  await page.addInitScript((seed) => {
    const listeners = new Set<(event: unknown) => void>();
    let snapshot: any = {
      schemaVersion: 1, storage: { state: "healthy" },
      runtime: { state: "unavailable", reason: "locked-runtime-no-mcp-rpc" },
      servers: structuredClone(seed),
    };
    const success = (request: any, result: unknown) => ({ method: request.method, requestId: request.requestId, ok: true, result });
    Object.defineProperty(window, "uclaw", { configurable: true, value: {
      client: {
        subscribe(listener: (event: unknown) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        async invoke(request: any) {
          if (request.method === "gateway.negotiate") return success(request, { protocolVersion: 4, methods: [], events: [], features: {} });
          if (request.method === "sessions.list") return success(request, { items: [], nextCursor: null, hasMore: false });
          if (request.method === "gateway.watch-status" || request.method === "subscriptions.cancel") return success(request, null);
          throw new Error(`Unexpected client IPC method: ${request.method}`);
        },
      },
      mcp: { async invoke(request: any) {
      if (request.method === "mcp.remove") snapshot = { ...snapshot, servers: snapshot.servers.filter((server: any) => server.id !== request.params.serverId) };
      if (request.method === "mcp.set-enabled") snapshot = { ...snapshot, servers: snapshot.servers.map((server: any) => server.id === request.params.serverId ? { ...server, enabled: request.params.enabled, status: request.params.enabled ? "unavailable" : "disabled" } : server) };
      if (request.method === "mcp.cancel") return success(request, null);
      if (request.method === "capabilities.tools") return success(request, {
        agentId: "main", sessionKey: "agent:main:main",
        catalog: { groups: [{ id: "core", label: "Core catalog", source: "core", tools: [{ id: "read", label: "Read", description: "Read", source: "core", defaultProfiles: ["coding"] }] }] },
        commands: [{ name: "status", description: "Show status", source: "native", scope: "both", acceptsArgs: false }],
        effective: { profile: "coding", groups: [{ id: "mcp", label: "Effective MCP", source: "mcp", tools: [{ id: "docs.search", label: "Docs search", description: "Search docs", source: "mcp", risk: "medium" }] }], notices: [] },
      });
      if (request.method === "capabilities.approvals-get") return success(request, { exists: true, hash: "hash-1", policy: { security: "allowlist", ask: "on-miss", askFallback: "deny", autoAllowSkills: false } });
      if (request.method === "capabilities.approvals-set") return success(request, { exists: true, hash: "hash-2", policy: request.params.policy });
      return success(request, snapshot);
      } },
    } });
  }, servers);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`MCP management fits ${viewport.width}px and preserves runtime boundary`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installMcpBridge(page);
    await page.goto("/");
    await page.getByRole("link", { name: "能力" }).click();
    await page.getByRole("tab", { name: "MCP" }).click();
    await expect(page.getByRole("heading", { name: "MCP、工具与审批" })).toBeVisible();
    await expect(page.getByText("OpenClaw runtime 未提供 MCP RPC")).toBeVisible();
    await expect(page.getByText("Docs MCP")).toBeVisible();
    await expect(page.getByText("Local MCP")).toBeVisible();
    await expect(page.getByRole("button", { name: "测试 Docs MCP" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "重连 Local MCP" })).toBeDisabled();
    await page.getByRole("button", { name: "工具与命令" }).click();
    await expect(page.getByText("Core catalog")).toBeVisible();
    await expect(page.getByText("Effective MCP")).toBeVisible();
    await page.getByRole("button", { name: "审批策略" }).click();
    await expect(page.getByLabel("Exec security")).toHaveValue("allowlist");
    await expect.poll(() => page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }))).toEqual({ document: 0, body: 0 });
    const rows = page.locator(".mcp-row");
    for (let index = 0; index < await rows.count(); index += 1) {
      const box = await rows.nth(index).boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect(box?.width).toBeLessThanOrEqual(viewport.width);
    }
  });
}
