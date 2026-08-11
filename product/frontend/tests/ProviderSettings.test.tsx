// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import type { ProviderIpcRequest, ProviderIpcResponse, ProviderSnapshot } from "@uclaw/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderSettings } from "../src/features/providers/ProviderSettings";

const initialSnapshot: ProviderSnapshot = {
  schemaVersion: 1,
  selectedProviderId: "openai",
  providers: [{
    id: "openai",
    templateId: "openai",
    name: "OpenAI",
    enabled: true,
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.4",
    apiKeyConfigured: false,
    verification: { state: "unverified" },
  }],
  network: { httpProxy: null, httpsProxy: null, noProxy: ["localhost", "127.0.0.1", "::1"] },
};

const success = (request: ProviderIpcRequest, result: unknown) => ({
  method: request.method,
  requestId: request.requestId,
  ok: true,
  result,
}) as ProviderIpcResponse;

describe("ProviderSettings authoritative UI state", () => {
  const getComputedStyle = window.getComputedStyle.bind(window);

  beforeEach(() => {
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getComputedStyle(element));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete window.uclaw;
    localStorage.clear();
    sessionStorage.clear();
  });

  it("discards mutation results and renders a fresh providers.list readback", async () => {
    const authoritative: ProviderSnapshot = {
      ...initialSnapshot,
      providers: [{ ...initialSnapshot.providers[0], name: "OpenAI (OpenClaw)" }],
    };
    let listCalls = 0;
    const invoke = vi.fn(async (request: ProviderIpcRequest) => {
      if (request.method === "providers.list") return success(request, listCalls++ === 0 ? initialSnapshot : authoritative);
      return success(request, {
        ...initialSnapshot,
        providers: [{ ...initialSnapshot.providers[0], name: "optimistic renderer value" }],
      });
    });
    window.uclaw = { providers: { invoke } } as typeof window.uclaw;

    render(<ProviderSettings />);
    fireEvent.click(await screen.findByRole("switch", { name: "启用 OpenAI" }));

    expect(await screen.findByText("OpenAI (OpenClaw)")).toBeVisible();
    expect(screen.queryByText("optimistic renderer value")).not.toBeInTheDocument();
    expect(invoke.mock.calls.filter(([request]) => request.method === "providers.list")).toHaveLength(2);
  });

  it("clears API Key input before IPC settles and never persists or logs the secret", async () => {
    let resolveWrite: ((response: ProviderIpcResponse) => void) | undefined;
    const writePending = new Promise<ProviderIpcResponse>((resolve) => { resolveWrite = resolve; });
    const invoke = vi.fn(async (request: ProviderIpcRequest) => {
      if (request.method === "providers.set-api-key") return writePending;
      return success(request, initialSnapshot);
    });
    const localSet = vi.spyOn(Storage.prototype, "setItem");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    window.uclaw = { providers: { invoke } } as typeof window.uclaw;

    render(<ProviderSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "管理 OpenAI API Key" }));
    const keyInput = screen.getByLabelText("新 API Key");
    fireEvent.change(keyInput, { target: { value: "sk-one-shot-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Key" }));

    expect(keyInput).toHaveValue("");
    expect(document.body.textContent).not.toContain("sk-one-shot-secret");
    expect(localSet).not.toHaveBeenCalled();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("sk-one-shot-secret");
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("sk-one-shot-secret");

    resolveWrite?.(success(invoke.mock.calls.find(([request]) => request.method === "providers.set-api-key")![0], initialSnapshot));
  });

  it("explains empty local discovery and separates invalid proxy from save failure", async () => {
    const invoke = vi.fn(async (request: ProviderIpcRequest) => {
      if (request.method === "providers.discover-local") return success(request, { state: "empty", models: [] });
      if (request.method === "providers.set-network") {
        return { method: request.method, requestId: request.requestId, ok: false, error: { code: "UNAVAILABLE", message: "secret upstream detail", retryable: true } } as ProviderIpcResponse;
      }
      return success(request, initialSnapshot);
    });
    window.uclaw = { providers: { invoke } } as typeof window.uclaw;

    render(<ProviderSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "刷新本地模型" }));
    expect(await screen.findByText(/请确认 Ollama 或 LM Studio 已启动/)).toBeVisible();

    fireEvent.change(screen.getByLabelText("HTTP 代理"), { target: { value: "socks5://127.0.0.1:1080" } });
    fireEvent.click(screen.getByRole("button", { name: "保存代理设置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("代理地址无效");

    fireEvent.change(screen.getByLabelText("HTTP 代理"), { target: { value: "https://proxy.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "保存代理设置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("代理设置保存失败");
    expect(document.body.textContent).not.toContain("secret upstream detail");
  });

  it("loads schema-driven OpenClaw config and reads it back after apply", async () => {
    let configuredPort = 18789;
    const invoke = vi.fn(async (request: ProviderIpcRequest) => {
      if (request.method === "providers.config-schema") return success(request, { schema: { type: "object", properties: { gateway: { type: "object" } } } });
      if (request.method === "providers.config-get") return success(request, { config: { gateway: { port: configuredPort }, models: { providers: { openai: { apiKey: "[REDACTED]" } } } } });
      if (request.method === "providers.config-apply") {
        configuredPort = (request.params.config.gateway as { port: number }).port;
        return success(request, { config: { gateway: { port: 99999 } } });
      }
      return success(request, initialSnapshot);
    });
    window.uclaw = { providers: { invoke } } as typeof window.uclaw;

    render(<ProviderSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "管理 OpenClaw 配置" }));
    const editor = await screen.findByLabelText("OpenClaw 配置 JSON");
    expect((editor as HTMLTextAreaElement).value).toContain('"port": 18789');
    fireEvent.change(editor, { target: { value: '{"gateway":{"port":18790},"models":{"providers":{"openai":{"apiKey":"[REDACTED]"}}}}' } });
    fireEvent.click(screen.getByRole("button", { name: "应用 OpenClaw 配置" }));

    await vi.waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain('"port": 18790'));
    expect(invoke.mock.calls.map(([request]) => request.method)).toEqual(expect.arrayContaining([
      "providers.config-schema", "providers.config-get", "providers.config-apply", "providers.config-get",
    ]));
    expect(document.body.textContent).not.toMatch(/sk-[a-z]/iu);
  });

  it("validates OpenClaw config with config.schema before config.apply", async () => {
    const invoke = vi.fn(async (request: ProviderIpcRequest) => {
      if (request.method === "providers.config-schema") return success(request, {
        schema: {
          type: "object",
          required: ["gateway"],
          properties: {
            gateway: {
              type: "object",
              required: ["port"],
              properties: { port: { type: "integer", minimum: 1, maximum: 65535 } },
            },
          },
        },
        uiHints: { "/gateway/port": { label: "Gateway 端口" } },
      });
      if (request.method === "providers.config-get") return success(request, { config: { gateway: { port: 18789 } } });
      if (request.method === "providers.config-apply") return success(request, { config: request.params.config });
      return success(request, initialSnapshot);
    });
    window.uclaw = { providers: { invoke } } as typeof window.uclaw;

    render(<ProviderSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "管理 OpenClaw 配置" }));
    const editor = await screen.findByLabelText("OpenClaw 配置 JSON");
    fireEvent.change(editor, { target: { value: '{"gateway":{"port":99999}}' } });
    fireEvent.click(screen.getByRole("button", { name: "应用 OpenClaw 配置" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Gateway 端口");
    expect(screen.getByRole("alert")).toHaveTextContent("65535");
    expect(invoke.mock.calls.some(([request]) => request.method === "providers.config-apply")).toBe(false);
  });
});
