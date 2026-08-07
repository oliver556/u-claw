import type { IpcResponse, WindowIpcRequest } from "@uclaw/shared";
import { Modal, Tooltip } from "antd";
import { Copy, Cpu, HardDrive, Maximize2, Minus, Radio, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { semanticCssVariables } from "../theme/tokens";

declare global {
  interface Window {
    uclaw?: {
      window?: {
        invoke?: (request: WindowIpcRequest) => Promise<IpcResponse>;
        onMaximizedChange?: (listener: (isMaximized: boolean) => void) => () => void;
      };
    };
  }
}

let windowRequestSequence = 0;

export function AppTitlebar() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchOpenRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const openSearch = useCallback(() => {
    if (searchOpenRef.current) {
      searchRef.current?.focus();
      return;
    }
    searchOpenRef.current = true;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setSearchOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    searchOpenRef.current = false;
    setSearchOpen(false);
    previousFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      }
      if (event.key === "Escape" && searchOpenRef.current) closeSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSearch, openSearch]);

  const invokeWindow = useCallback(async (method: WindowIpcRequest["method"]) => {
    const invoke = window.uclaw?.window?.invoke;
    if (!invoke) {
      setWindowError("窗口控制不可用");
      return;
    }

    windowRequestSequence += 1;
    const request: WindowIpcRequest = {
      method,
      requestId: `window-${windowRequestSequence}`,
      params: {},
    };
    try {
      const response = await invoke(request);
      setWindowError(response.ok ? null : response.error.message);
    } catch {
      setWindowError("窗口操作失败，请重试");
    }
  }, []);

  useEffect(() => window.uclaw?.window?.onMaximizedChange?.(setIsMaximized), []);

  const toggleMaximizeFromTitlebar = (event: React.MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button, input")) return;
    void invokeWindow("toggle-maximize");
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
          <button className="command-search" type="button" onClick={openSearch} aria-label="打开全局搜索">
            <Search aria-hidden="true" /><span>搜索会话、文件或能力</span><kbd>Ctrl K</kbd>
          </button>
        </Tooltip>
        <div className="runtime-status" aria-label="运行状态">
          <span className="status-item"><i className="status-dot success" /><HardDrive aria-hidden="true" />U 盘已连接</span>
          <span className="status-item"><i className="status-dot success" /><Radio aria-hidden="true" />Gateway</span>
          <span className="model-status"><Cpu aria-hidden="true" />GPT-5.2</span>
        </div>
        <div className="window-controls" aria-label="窗口控制">
          <Tooltip title="最小化"><button type="button" aria-label="最小化" onClick={() => void invokeWindow("minimize")}><Minus aria-hidden="true" /></button></Tooltip>
          <Tooltip title={isMaximized ? "还原" : "最大化"}><button type="button" aria-label={isMaximized ? "还原" : "最大化"} onClick={() => void invokeWindow("toggle-maximize")}>{isMaximized ? <Copy aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}</button></Tooltip>
          <Tooltip title="关闭"><button className="window-close" type="button" aria-label="关闭" onClick={() => void invokeWindow("close")}><X aria-hidden="true" /></button></Tooltip>
        </div>
        {windowError ? <div className="window-error" role="alert">{windowError}</div> : null}
      </header>
      <Modal
        className="command-modal"
        closable={false}
        footer={null}
        keyboard
        maskClosable
        onCancel={closeSearch}
        open={searchOpen}
        style={semanticCssVariables}
        title={<span className="sr-only">全局搜索</span>}
        width={620}
        afterOpenChange={(open) => open && searchRef.current?.focus()}
      >
        <div className="command-dialog">
          <Search aria-hidden="true" />
          <input ref={searchRef} autoFocus type="search" aria-label="全局搜索" placeholder="搜索会话、文件或能力" />
          <kbd>Esc</kbd>
        </div>
      </Modal>
    </>
  );
}
