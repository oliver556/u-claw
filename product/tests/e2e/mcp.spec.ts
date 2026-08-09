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
    let snapshot: any = {
      schemaVersion: 1, storage: { state: "healthy" },
      runtime: { state: "unavailable", reason: "locked-runtime-no-mcp-rpc" },
      servers: structuredClone(seed),
    };
    const success = (request: any, result: unknown) => ({ method: request.method, requestId: request.requestId, ok: true, result });
    Object.defineProperty(window, "uclaw", { configurable: true, value: { mcp: { async invoke(request: any) {
      if (request.method === "mcp.remove") snapshot = { ...snapshot, servers: snapshot.servers.filter((server: any) => server.id !== request.params.serverId) };
      if (request.method === "mcp.set-enabled") snapshot = { ...snapshot, servers: snapshot.servers.map((server: any) => server.id === request.params.serverId ? { ...server, enabled: request.params.enabled, status: request.params.enabled ? "unavailable" : "disabled" } : server) };
      if (request.method === "mcp.cancel") return success(request, null);
      return success(request, snapshot);
    } } } });
  }, servers);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`MCP management fits ${viewport.width}px and preserves runtime boundary`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installMcpBridge(page);
    await page.goto("/");
    await page.getByRole("link", { name: "能力" }).click();
    await page.getByRole("tab", { name: "MCP" }).click();
    await expect(page.getByRole("heading", { name: "MCP servers" })).toBeVisible();
    await expect(page.getByText("OpenClaw runtime 未提供 MCP RPC")).toBeVisible();
    await expect(page.getByText("Docs MCP")).toBeVisible();
    await expect(page.getByText("Local MCP")).toBeVisible();
    await expect(page.getByRole("button", { name: "测试 Docs MCP" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "重连 Local MCP" })).toBeDisabled();
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
