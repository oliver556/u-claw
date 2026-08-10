import { expect, test } from "@playwright/test";

test("mock chat covers sessions, tool, approval, stop, and streaming completion", async ({ page }) => {
  const consoleProblems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleProblems.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await expect(page.getByText("Ready")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Execute command" })).toContainText("等待授权");
  const approval = page.getByLabel(/命令执行授权/);
  await expect(approval).toContainText("Run command");
  await expect(approval.getByRole("button", { name: "允许一次" })).toBeDisabled();

  await page.getByRole("button", { name: "新建会话" }).click();
  await expect(page.getByRole("heading", { name: "新会话" })).toBeVisible();
  await expect(page.getByText("开始一段新会话")).toBeVisible();

  const composer = page.getByRole("textbox", { name: "给 U-Claw 发送消息" });
  await composer.fill("先停止这次生成");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByText("已停止")).toBeVisible();

  await composer.fill("完成 Mock 主链");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.locator(".assistant-message").last().locator(".message-content").getByText("Fixture", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Inspect workspace" })).toContainText("等待授权");
  const dynamicApproval = page.getByLabel(/命令执行授权/).filter({ hasText: "Inspect workspace" });
  await expect(dynamicApproval).toBeVisible();
  await expect(dynamicApproval.getByRole("button", { name: "允许一次" })).toBeDisabled();
  await expect(page.getByRole("main").getByText("Fixture response")).toBeVisible();
  await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible();

  await page.getByRole("button", { name: /Welcome/ }).click();
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await expect(page.getByText("Ready")).toBeVisible();
  await page.getByRole("button", { name: /完成 Mock 主链/ }).click();
  await expect(page.getByRole("heading", { name: "完成 Mock 主链" })).toBeVisible();
  await expect(page.locator(".message").filter({ hasText: "完成 Mock 主链" })).toBeVisible();
  await expect(page.locator(".message").filter({ hasText: "Fixture response" })).toBeVisible();
  expect(consoleProblems).toEqual([]);
});

test("disconnect preserves the active draft and resumes sending after recovery", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const composer = page.getByRole("textbox", { name: "给 U-Claw 发送消息" });
  await composer.fill("断线期间保留的草稿");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("uclaw:mock-connection", { detail: false })));

  await expect(page.getByRole("alert").filter({ hasText: "服务连接已断开" })).toBeVisible();
  await expect(composer).toBeDisabled();
  await expect(composer).toHaveValue("断线期间保留的草稿");
  await expect(page.getByRole("button", { name: "发送消息" })).toBeDisabled();

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("uclaw:mock-connection", { detail: true })));
  await expect(page.getByRole("alert").filter({ hasText: "服务连接已断开" })).toBeHidden();
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue("断线期间保留的草稿");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByRole("main").getByText("Fixture response")).toBeVisible();
  await expect(composer).toHaveValue("");
});

test("chat workspace stays usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "给 U-Claw 发送消息" })).toBeVisible();
  await page.getByRole("button", { name: "展开会话栏" }).click();
  await expect(page.getByRole("complementary", { name: "会话栏" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Welcome/ })).toBeVisible();
});
