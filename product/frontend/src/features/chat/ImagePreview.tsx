import { Copy, LoaderCircle, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";

export interface ImagePreviewProps {
  sourceUrl: string;
  alt: string;
  operationBusy: boolean;
  onClose(): void;
  onContextMenu(event: React.MouseEvent<HTMLImageElement>): void;
  onCopy(): void;
}

type Point = { x: number; y: number };
type DragState = Point & { pointerId: number; origin: Point };

const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const ZOOM_STEP = 25;

export function ImagePreview({ sourceUrl, alt, operationBusy, onClose, onContextMenu, onCopy }: ImagePreviewProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<number>();
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const dragRef = useRef<DragState | undefined>(undefined);

  const setNumericZoom = useCallback((next: number) => {
    setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next)));
    setOffset({ x: 0, y: 0 });
  }, []);
  const changeZoom = useCallback((delta: number) => {
    setZoom((current) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (current ?? 100) + delta)));
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const onWheel = (event: WheelEvent<HTMLImageElement>) => {
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (zoom === undefined) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: offset };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset({ x: drag.origin.x + event.clientX - drag.x, y: drag.origin.y + event.clientY - drag.y });
  };
  const endDrag = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = undefined;
  };

  return createPortal(<div
    ref={dialogRef}
    className="image-preview"
    role="dialog"
    aria-modal="true"
    aria-label={`图片预览：${alt}`}
    data-zoom={zoom ?? "fit"}
    tabIndex={-1}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
  >
    <div className="image-preview-toolbar" role="toolbar" aria-label="图片预览工具" onClick={(event) => event.stopPropagation()}>
      <button type="button" aria-label="缩小" title="缩小" disabled={zoom === MIN_ZOOM} onClick={() => changeZoom(-ZOOM_STEP)}><ZoomOut /></button>
      <button type="button" className="image-preview-actual" aria-label="原始大小 100%" title="原始大小 100%" onClick={() => setNumericZoom(100)}>100%</button>
      <button type="button" aria-label="放大" title="放大" disabled={zoom === MAX_ZOOM} onClick={() => changeZoom(ZOOM_STEP)}><ZoomIn /></button>
      <span className="image-preview-divider" />
      <button type="button" aria-label="复制图片" title="复制图片" disabled={operationBusy} onClick={onCopy}>{operationBusy ? <LoaderCircle className="spin" /> : <Copy />}</button>
      <button type="button" aria-label="关闭预览" title="关闭预览" onClick={onClose}><X /></button>
    </div>
    <div className="image-preview-stage" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <img
        className={zoom === undefined ? "fit" : "zoomed"}
        src={sourceUrl}
        alt={alt}
        draggable={false}
        style={zoom === undefined ? undefined : { transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom / 100})` }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={onContextMenu}
      />
    </div>
  </div>, document.body);
}
