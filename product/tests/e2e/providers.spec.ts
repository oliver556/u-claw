import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let snapshot = {
      schemaVersion: 1,
      selectedProviderId: "openai" as string | null,
      providers: [
        { id: "openai", templateId: "openai", name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKeyConfigured: false, verification: { state: "unverified" } },
        { id: "deepseek", templateId: "deepseek", name: "DeepSeek", enabled: true, baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", apiKeyConfigured: false, verification: { state: "unverified" } },
      ],
      network: { httpProxy: null as string | null, httpsProxy: null as string | null, noProxy: ["localhost", "127.0.0.1", "::1"] },
    };
    const success = (request: { method: string; requestId: string }, result: unknown) => ({ method: request.method, requestId: request.requestId, ok: true, result });
    Object.defineProperty(window, "uclaw", {
      configurable: true,
      value: {
        providers: {
          async invoke(request: { method: string; requestId: string; params: Record<string, any> }) {
            if (request.method === "providers.select") snapshot = { ...snapshot, selectedProviderId: request.params.providerId };
            if (request.method === "providers.set-api-key") snapshot = { ...snapshot, providers: snapshot.providers.map((provider) => provider.id === request.params.providerId ? { ...provider, apiKeyConfigured: true, apiKeyHint: "...6789" } : provider) };
            if (request.method === "providers.create") snapshot = { ...snapshot, providers: [...snapshot.providers, { ...request.params.provider, apiKeyConfigured: false, verification: { state: "unverified" } }] };
            if (request.method === "providers.set-network") snapshot = { ...snapshot, network: request.params.network };
            if (request.method === "providers.discover-local") return success(request, { state: "ready", models: [{ id: "llama3.2:latest", label: "llama3.2:latest", source: "ollama", baseUrl: "http://127.0.0.1:11434/v1" }] });
            if (request.method === "providers.verify") return success(request, { state: "succeeded", category: "ok", code: "OK", message: "连接成功。", retryable: false });
            if (request.method === "providers.cancel") return success(request, null);
            return success(request, snapshot);
          },
        },
      },
    });
  });
});

test("provider settings manages selection, keys, custom URL validation, and narrow layout", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await page.getByRole("link", { name: "能力" }).click();
  await expect(page.getByRole("heading", { name: "模型 Provider" })).toBeVisible();

  await page.getByRole("button", { name: "选择 DeepSeek" }).click();
  await expect(page.locator(".provider-row.selected")).toContainText("DeepSeek");
  await page.getByRole("button", { name: "管理 DeepSeek API Key" }).click();
  await page.getByLabel("新 API Key").fill("sk-browser-secret-6789");
  await page.getByRole("button", { name: "保存 Key" }).click();
  await expect(page.getByText("...6789")).toBeVisible();
  await expect(page.getByText("sk-browser-secret-6789")).toHaveCount(0);

  await page.getByRole("button", { name: "新增 Provider" }).click();
  await page.getByLabel("Provider ID").fill("custom-one");
  await page.getByLabel("显示名称").fill("自定义服务");
  await page.getByLabel("Base URL").fill("file:///C:/secret");
  await page.getByLabel("模型名").fill("model-1");
  await page.getByRole("button", { name: "保存 Provider" }).click();
  await expect(page.getByRole("alert")).toContainText("Base URL");
  await page.getByLabel("Base URL").fill("https://models.example.com/v1");
  await page.getByRole("button", { name: "保存 Provider" }).click();
  await expect(page.getByText("自定义服务")).toBeVisible();

  await page.getByRole("button", { name: "刷新本地模型" }).click();
  await page.getByRole("button", { name: "使用 llama3.2:latest" }).click();
  await expect(page.locator(".provider-row.selected")).toContainText("llama3.2:latest");
  await page.getByRole("button", { name: "验证 DeepSeek" }).click();
  await expect(page.getByText("连接成功。")).toBeVisible();
  await page.getByLabel("HTTP 代理").fill("http://proxy.example.com:8080");
  await page.getByLabel("NO_PROXY").fill("localhost, 127.0.0.1, ::1, .example.com");
  await page.getByRole("button", { name: "保存代理设置" }).click();
  await expect(page.getByText("代理设置已保存")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 780 });
  await expect(page.getByRole("heading", { name: "模型 Provider" })).toBeVisible();
  await expect(page.locator(".provider-row").first()).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const toolBoxes = await page.locator(".provider-tool").evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  }));
  expect(toolBoxes.every((box) => box.left >= 0 && box.right <= 390)).toBe(true);
  expect(toolBoxes[0].bottom).toBeLessThanOrEqual(toolBoxes[1].top);
});
