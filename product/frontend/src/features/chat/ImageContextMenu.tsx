import { Copy, Download, LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export type ImageOperation = "copy" | "save";

export interface ImageContextMenuProps {
  x: number;
  y: number;
  busy?: ImageOperation;
  onAction(operation: ImageOperation): void;
  onClose(): void;
}

export function ImageContextMenu({ x, y, busy, onAction, onClose }: ImageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const left = Math.max(8, Math.min(x, window.innerWidth - 184));
  const top = Math.max(8, Math.min(y, window.innerHeight - 104));

  useEffect(() => {
    const closeForPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeForKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", closeForPointer);
    document.addEventListener("keydown", closeForKey);
    return () => {
      document.removeEventListener("pointerdown", closeForPointer);
      document.removeEventListener("keydown", closeForKey);
    };
  }, [onClose]);

  return createPortal(<div ref={menuRef} className="image-context-menu" role="menu" aria-label="图片操作" style={{ left, top }}>
    <button type="button" role="menuitem" disabled={busy !== undefined} onClick={() => onAction("copy")}>
      {busy === "copy" ? <LoaderCircle className="spin" /> : <Copy />}<span>复制图片</span>
    </button>
    <button type="button" role="menuitem" disabled={busy !== undefined} onClick={() => onAction("save")}>
      {busy === "save" ? <LoaderCircle className="spin" /> : <Download />}<span>另存为图片</span>
    </button>
  </div>, document.body);
}
