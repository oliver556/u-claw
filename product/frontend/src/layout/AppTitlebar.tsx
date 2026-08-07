import { Cpu, HardDrive, Maximize2, Minus, Radio, Search, X } from "lucide-react";
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

  return (
    <>
      <header className="titlebar">
        <div className="titlebar-brand" aria-label="U-Claw 随身工作区">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <strong>U-Claw</strong>
          <span className="workspace-name">随身工作区</span>
        </div>
        <button className="command-search" type="button" onClick={() => setSearchOpen(true)} aria-label="打开全局搜索">
          <Search aria-hidden="true" /><span>搜索会话、文件或能力</span><kbd>Ctrl K</kbd>
        </button>
        <div className="runtime-status" aria-label="运行状态">
          <span className="status-item"><i className="status-dot success" /><HardDrive aria-hidden="true" />U 盘已连接</span>
          <span className="status-item"><i className="status-dot success" /><Radio aria-hidden="true" />Gateway</span>
          <span className="model-status"><Cpu aria-hidden="true" />GPT-5.2</span>
        </div>
        <div className="window-controls" aria-label="窗口控制">
          <button type="button" aria-label="最小化" onClick={() => invokeWindow("minimize")}><Minus /></button>
          <button type="button" aria-label="最大化或还原" onClick={() => invokeWindow("toggle-maximize")}><Maximize2 /></button>
          <button className="window-close" type="button" aria-label="关闭" onClick={() => invokeWindow("close")}><X /></button>
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
