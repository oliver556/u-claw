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
            if (request.method === "providers.verify") return { method: request.method, requestId: request.requestId, ok: false, error: { code: "UNAVAILABLE", message: "Unavailable", retryable: false, recoveryActions: [], causeDetails: {} } };
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

  await page.setViewportSize({ width: 390, height: 780 });
  await expect(page.getByRole("heading", { name: "模型 Provider" })).toBeVisible();
  await expect(page.locator(".provider-row").first()).toBeInViewport();
});
