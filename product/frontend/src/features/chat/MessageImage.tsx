import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

import type { ImageOperationIpcResponse } from "@uclaw/shared";
import { createPortal } from "react-dom";

import { invokeImageOperation } from "../../app/renderer-client";
import { ImageContextMenu, type ImageOperation } from "./ImageContextMenu";
import { ImagePreview } from "./ImagePreview";

export interface MessageImageProps {
  sourceUrl: string;
  alt: string;
  suggestedName: string;
}

type MenuPoint = { x: number; y: number };
type Feedback = { tone: "success" | "error"; message: string };

export function MessageImage({ sourceUrl, alt, suggestedName }: MessageImageProps) {
  const thumbnailRef = useRef<HTMLButtonElement>(null);
  const feedbackTimerRef = useRef<number | undefined>(undefined);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [menu, setMenu] = useState<MenuPoint>();
  const [busy, setBusy] = useState<ImageOperation>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => () => {
    if (feedbackTimerRef.current !== undefined) window.clearTimeout(feedbackTimerRef.current);
  }, []);

  const closePreview = useCallback(() => {
    setPreviewOpen(false);
    setMenu(undefined);
    window.requestAnimationFrame(() => thumbnailRef.current?.focus());
  }, []);
  const openContextMenu = useCallback((event: MouseEvent<HTMLImageElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY });
  }, []);
  const showFeedback = useCallback((next: Feedback) => {
    setFeedback(next);
    if (feedbackTimerRef.current !== undefined) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => setFeedback(undefined), 2_400);
  }, []);
  const runOperation = useCallback(async (operation: ImageOperation) => {
    if (busy !== undefined) return;
    setBusy(operation);
    let response: ImageOperationIpcResponse | undefined;
    try {
      response = await invokeImageOperation(operation === "copy" ? "image.copy" : "image.save", sourceUrl, suggestedName);
      if (!response.ok) {
        showFeedback({ tone: "error", message: operation === "copy" ? "无法复制此图片。" : "图片保存失败，请重试。" });
      } else if (response.result.status === "completed") {
        showFeedback({ tone: "success", message: operation === "copy" ? "图片已复制" : "图片已保存" });
      }
    } catch {
      showFeedback({ tone: "error", message: operation === "copy" ? "无法复制此图片。" : "图片保存失败，请重试。" });
    } finally {
      setBusy(undefined);
      if (response?.ok && response.result.status !== "cancelled") setMenu(undefined);
    }
  }, [busy, showFeedback, sourceUrl, suggestedName]);

  return <>
    <figure className="message-image">
      {loadFailed
        ? <div className="message-image-error" role="status">图片加载失败</div>
        : <button ref={thumbnailRef} type="button" aria-label={`预览图片：${alt}`} onClick={() => { setMenu(undefined); setPreviewOpen(true); }}>
          <img src={sourceUrl} alt={alt} loading="lazy" onError={() => setLoadFailed(true)} onContextMenu={openContextMenu} />
        </button>}
    </figure>
    {previewOpen ? <ImagePreview
      key={sourceUrl}
      sourceUrl={sourceUrl}
      alt={alt}
      operationBusy={busy !== undefined}
      onClose={closePreview}
      onContextMenu={openContextMenu}
      onCopy={() => void runOperation("copy")}
    /> : null}
    {menu ? <ImageContextMenu x={menu.x} y={menu.y} busy={busy} onAction={(operation) => void runOperation(operation)} onClose={() => setMenu(undefined)} /> : null}
    {feedback ? createPortal(<div className={`image-operation-feedback ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</div>, document.body) : null}
  </>;
}
