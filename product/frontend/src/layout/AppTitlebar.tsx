import { Tooltip } from "antd";
import { Copy, Cpu, HardDrive, Maximize2, Minus, Radio, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    uclaw?: {
      window?: {
        invoke?: (request: {
          method: "minimize" | "toggle-maximize" | "close";
          requestId: string;
          params: Record<string, never>;
        }) => Promise<unknown>;
        onMaximizedChange?: (listener: (isMaximized: boolean) => void) => () => void;
      };
    };
  }
}

let windowRequestSequence = 0;

function invokeWindow(method: "minimize" | "toggle-maximize" | "close") {
  const invoke = window.uclaw?.window?.invoke;
  if (!invoke) return;
  windowRequestSequence += 1;
  void invoke({ method, requestId: `window-${windowRequestSequence}`, params: {} }).catch(() => undefined);
}

export function AppTitlebar() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => window.uclaw?.window?.onMaximizedChange?.(setIsMaximized), []);

  const toggleMaximizeFromTitlebar = (event: React.MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button, input")) return;
    invokeWindow("toggle-maximize");
  };

  return (
    <>
      <header className="titlebar" onDoubleClick={toggleMaximizeFromTitlebar}>
        <div className="titlebar-brand" aria-label="U-Claw 随身工作区">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <strong>U-Claw</strong>
          <span className="workspace-name">随身工作区</span>
        </div>
        <Tooltip title="打开全局搜索">
          <button className="command-search" type="button" onClick={() => setSearchOpen(true)} aria-label="打开全局搜索">
            <Search aria-hidden="true" /><span>搜索会话、文件或能力</span><kbd>Ctrl K</kbd>
          </button>
        </Tooltip>
        <div className="runtime-status" aria-label="运行状态">
          <span className="status-item"><i className="status-dot success" /><HardDrive aria-hidden="true" />U 盘已连接</span>
          <span className="status-item"><i className="status-dot success" /><Radio aria-hidden="true" />Gateway</span>
          <span className="model-status"><Cpu aria-hidden="true" />GPT-5.2</span>
        </div>
        <div className="window-controls" aria-label="窗口控制">
          <Tooltip title="最小化"><button type="button" aria-label="最小化" onClick={() => invokeWindow("minimize")}><Minus aria-hidden="true" /></button></Tooltip>
          <Tooltip title={isMaximized ? "还原" : "最大化"}><button type="button" aria-label={isMaximized ? "还原" : "最大化"} onClick={() => invokeWindow("toggle-maximize")}>{isMaximized ? <Copy aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}</button></Tooltip>
          <Tooltip title="关闭"><button className="window-close" type="button" aria-label="关闭" onClick={() => invokeWindow("close")}><X aria-hidden="true" /></button></Tooltip>
        </div>
      </header>
      {searchOpen ? (
        <div className="dialog-mask" onMouseDown={(event) => event.target === event.currentTarget && setSearchOpen(false)}>
          <section className="command-dialog" role="dialog" aria-modal="true" aria-label="全局搜索">
            <Search aria-hidden="true" />
            <input ref={searchRef} type="search" aria-label="全局搜索" placeholder="搜索会话、文件或能力" />
            <kbd>Esc</kbd>
          </section>
        </div>
      ) : null}
    </>
  );
}
