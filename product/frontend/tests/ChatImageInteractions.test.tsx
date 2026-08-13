// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import type { ContentBlock, ImageOperationIpcRequest, ImageOperationIpcResponse } from "@uclaw/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { MessageContent } from "../src/features/chat/MessageContent";

const sourceUrl = "http://127.0.0.1:18789/api/chat/media/outgoing/agent%3Amain/123e4567-e89b-12d3-a456-426614174000/full";
const imageBlock: ContentBlock = {
  id: "image-1",
  type: "image",
  file: { id: "image-1", name: "portrait.png", mediaType: "image/png", size: 42, kind: "artifact" },
  alt: "人物肖像",
  sourceUrl,
};

type Invoke = (request: ImageOperationIpcRequest) => Promise<ImageOperationIpcResponse>;

function completed(request: ImageOperationIpcRequest): ImageOperationIpcResponse {
  return { method: request.method, requestId: request.requestId, ok: true, result: { status: "completed" } };
}

function failed(request: ImageOperationIpcRequest, message: string): ImageOperationIpcResponse {
  return {
    method: request.method,
    requestId: request.requestId,
    ok: false,
    error: { code: "UNKNOWN", message, retryable: true, recoveryActions: ["retry"], causeDetails: {} },
  };
}

function installBridge(invoke: Invoke = async (request) => completed(request)) {
  Object.defineProperty(window, "uclaw", {
    configurable: true,
    value: { images: { invoke: vi.fn(invoke) } },
  });
  return (window as unknown as { uclaw: { images: { invoke: ReturnType<typeof vi.fn<Invoke>> } } }).uclaw.images.invoke;
}

function openPreview() {
  render(<MessageContent blocks={[imageBlock]} />);
  const thumbnail = screen.getByRole("button", { name: "预览图片：人物肖像" });
  thumbnail.focus();
  fireEvent.click(thumbnail);
  return { thumbnail, dialog: screen.getByRole("dialog", { name: "图片预览：人物肖像" }) };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.uclaw;
  document.body.style.overflow = "";
});

describe("chat image preview", () => {
  it("uses a stable dark fullscreen backdrop in every app theme", () => {
    const css = readFileSync(`${process.cwd()}/frontend/src/theme/global.css`, "utf8");
    expect(css).toMatch(/\.image-preview\s*\{[^}]*background:\s*rgba\(8,\s*10,\s*12,\s*\.94\)/u);
  });

  it("opens fitted, locks scrolling, closes with Escape, and restores focus", async () => {
    installBridge();
    const { thumbnail, dialog } = openPreview();

    expect(dialog).toHaveAttribute("data-zoom", "fit");
    expect(document.body).toHaveStyle({ overflow: "hidden" });
    await waitFor(() => expect(dialog).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "图片预览：人物肖像" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveStyle({ overflow: "hidden" });
    await waitFor(() => expect(thumbnail).toHaveFocus());
  });

  it("resets zoom when the preview is reopened", () => {
    installBridge();
    const { dialog } = openPreview();
    fireEvent.click(within(dialog).getByRole("button", { name: "放大" }));
    expect(dialog).toHaveAttribute("data-zoom", "125");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭预览" }));

    fireEvent.click(screen.getByRole("button", { name: "预览图片：人物肖像" }));

    expect(screen.getByRole("dialog", { name: "图片预览：人物肖像" })).toHaveAttribute("data-zoom", "fit");
  });

  it("only closes for backdrop and close controls", () => {
    installBridge();
    const { dialog } = openPreview();

    fireEvent.click(within(dialog).getByRole("img", { name: "人物肖像" }));
    fireEvent.click(within(dialog).getByRole("toolbar", { name: "图片预览工具" }));
    expect(dialog).toBeInTheDocument();

    fireEvent.click(dialog);
    expect(dialog).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "预览图片：人物肖像" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("zooms in 25 percent steps, returns to 100 percent, and clamps at 25–400 percent", () => {
    installBridge();
    const { dialog } = openPreview();
    const image = within(dialog).getByRole("img", { name: "人物肖像" });

    fireEvent.click(within(dialog).getByRole("button", { name: "放大" }));
    expect(dialog).toHaveAttribute("data-zoom", "125");
    expect(image).toHaveStyle({ transform: "translate(0px, 0px) scale(1.25)" });

    fireEvent.wheel(image, { deltaY: -100 });
    expect(dialog).toHaveAttribute("data-zoom", "150");
    fireEvent.click(within(dialog).getByRole("button", { name: "原始大小 100%" }));
    expect(dialog).toHaveAttribute("data-zoom", "100");

    const zoomOut = within(dialog).getByRole("button", { name: "缩小" });
    for (let index = 0; index < 20; index += 1) fireEvent.click(zoomOut);
    expect(dialog).toHaveAttribute("data-zoom", "25");
    expect(zoomOut).toBeDisabled();

    const zoomIn = within(dialog).getByRole("button", { name: "放大" });
    for (let index = 0; index < 20; index += 1) fireEvent.click(zoomIn);
    expect(dialog).toHaveAttribute("data-zoom", "400");
    expect(zoomIn).toBeDisabled();
  });

  it("pans a zoomed image with pointer dragging", () => {
    installBridge();
    const { dialog } = openPreview();
    const image = within(dialog).getByRole("img", { name: "人物肖像" });
    fireEvent.click(within(dialog).getByRole("button", { name: "放大" }));

    const pointer = (type: string, values: { pointerId: number; clientX?: number; clientY?: number }) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])));
      fireEvent(image, event);
    };
    pointer("pointerdown", { pointerId: 7, clientX: 10, clientY: 15 });
    pointer("pointermove", { pointerId: 7, clientX: 45, clientY: 55 });
    pointer("pointerup", { pointerId: 7 });

    expect(image).toHaveStyle({ transform: "translate(35px, 40px) scale(1.25)" });
  });

  it("pans an overflowing image at 100 percent", () => {
    installBridge();
    const { dialog } = openPreview();
    const image = within(dialog).getByRole("img", { name: "人物肖像" });
    fireEvent.click(within(dialog).getByRole("button", { name: "原始大小 100%" }));

    const pointer = (type: string, values: { pointerId: number; clientX?: number; clientY?: number }) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])));
      fireEvent(image, event);
    };
    pointer("pointerdown", { pointerId: 8, clientX: 20, clientY: 25 });
    pointer("pointermove", { pointerId: 8, clientX: 50, clientY: 60 });
    pointer("pointerup", { pointerId: 8 });

    expect(image).toHaveStyle({ transform: "translate(30px, 35px) scale(1)" });
  });
});

describe("chat image operations", () => {
  it("opens the same context menu from thumbnail and preview", () => {
    installBridge();
    render(<MessageContent blocks={[imageBlock]} />);
    const thumbnailImage = screen.getByRole("img", { name: "人物肖像" });

    fireEvent.contextMenu(thumbnailImage, { clientX: 24, clientY: 36 });
    expect(screen.getByRole("menu", { name: "图片操作" })).toHaveStyle({ left: "24px", top: "36px" });
    expect(screen.getByRole("menuitem", { name: "复制图片" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "另存为图片" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "预览图片：人物肖像" }));
    fireEvent.contextMenu(within(screen.getByRole("dialog")).getByRole("img", { name: "人物肖像" }), { clientX: 60, clientY: 70 });
    expect(screen.getByRole("menu", { name: "图片操作" })).toHaveStyle({ left: "60px", top: "70px" });
  });

  it("invokes copy once while busy and reports success", async () => {
    let resolve!: (response: ImageOperationIpcResponse) => void;
    const invoke = installBridge((request) => new Promise((next) => {
      resolve = next;
      expect(request).toMatchObject({ method: "image.copy", params: { sourceUrl, suggestedName: "portrait.png" } });
    }));
    render(<MessageContent blocks={[imageBlock]} />);
    fireEvent.contextMenu(screen.getByRole("img", { name: "人物肖像" }));
    const copy = screen.getByRole("menuitem", { name: "复制图片" });

    fireEvent.click(copy);
    fireEvent.click(copy);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(copy).toBeDisabled();

    const request = vi.mocked(invoke).mock.calls[0]![0];
    resolve(completed(request));
    expect(await screen.findByRole("status")).toHaveTextContent("图片已复制");
  });

  it("shows stable errors and ignores save cancellation", async () => {
    const invoke = installBridge(async (request) => request.method === "image.copy"
      ? failed(request, "secret path")
      : { method: request.method, requestId: request.requestId, ok: true, result: { status: "cancelled" } });
    render(<MessageContent blocks={[imageBlock]} />);

    fireEvent.contextMenu(screen.getByRole("img", { name: "人物肖像" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "复制图片" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法复制此图片。");
    expect(screen.queryByText("secret path")).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole("img", { name: "人物肖像" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "另存为图片" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("图片保存失败，请重试。")).not.toBeInTheDocument();
    expect(screen.queryByText("图片已保存")).not.toBeInTheDocument();
  });

  it("reports save success and stable save failures", async () => {
    let saveShouldFail = false;
    installBridge(async (request) => saveShouldFail
      ? failed(request, "private path")
      : completed(request));
    render(<MessageContent blocks={[imageBlock]} />);

    fireEvent.contextMenu(screen.getByRole("img", { name: "人物肖像" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "另存为图片" }));
    expect(await screen.findByRole("status")).toHaveTextContent("图片已保存");

    saveShouldFail = true;
    fireEvent.contextMenu(screen.getByRole("img", { name: "人物肖像" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "另存为图片" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("图片保存失败，请重试。");
    expect(screen.queryByText("private path")).not.toBeInTheDocument();
  });

  it("disables preview copy while save is pending", () => {
    installBridge(() => new Promise(() => undefined));
    openPreview();
    fireEvent.contextMenu(within(screen.getByRole("dialog")).getByRole("img", { name: "人物肖像" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "另存为图片" }));

    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "复制图片" })).toBeDisabled();
  });

  it("keeps message layout stable when the thumbnail fails to load", () => {
    installBridge();
    render(<MessageContent blocks={[imageBlock]} />);

    fireEvent.error(screen.getByRole("img", { name: "人物肖像" }));

    expect(screen.getByRole("status")).toHaveTextContent("图片加载失败");
    expect(screen.queryByRole("button", { name: "预览图片：人物肖像" })).not.toBeInTheDocument();
  });
});
