import type { AttachmentIpcRequest, AttachmentIpcResponse, ChannelIpcRequest, ChannelIpcResponse, ClientIpcEvent, ClientIpcRequest, DataBridge, DiagnosticsIpcRequest, DiagnosticsIpcResponse, GatewayStatus, IpcResponse, McpIpcRequest, McpIpcResponse, PluginIpcRequest, PluginIpcResponse, ProviderIpcRequest, ProviderIpcResponse, RecoveryAction, ReleaseBridge, SessionAdvancedIpcRequest, SessionAdvancedIpcResponse, SkillIpcRequest, SkillIpcResponse, WindowIpcRequest } from "@uclaw/shared";
import { Modal, Tooltip } from "antd";
import { Activity, Copy, Cpu, HardDrive, Maximize2, Minus, Radio, RotateCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

declare global {
  interface Window {
    uclaw?: {
      window?: {
        invoke?: (request: WindowIpcRequest) => Promise<IpcResponse>;
        onMaximizedChange?: (listener: (isMaximized: boolean) => void) => () => void;
      };
      client?: {
        invoke(request: ClientIpcRequest): Promise<IpcResponse>;
        subscribe(listener: (event: ClientIpcEvent) => void): () => void;
      };
      attachments?: {
        invoke(request: AttachmentIpcRequest): Promise<AttachmentIpcResponse>;
      };
      providers?: {
        invoke(request: ProviderIpcRequest): Promise<ProviderIpcResponse>;
      };
      skills?: {
        invoke(request: SkillIpcRequest): Promise<SkillIpcResponse>;
      };
      plugins?: {
        invoke(request: PluginIpcRequest): Promise<PluginIpcResponse>;
      };
      channels?: {
        invoke(request: ChannelIpcRequest): Promise<ChannelIpcResponse>;
      };
      mcp?: {
        invoke(request: McpIpcRequest): Promise<McpIpcResponse>;
      };
      sessionAdvanced?: {
        invoke(request: SessionAdvancedIpcRequest): Promise<SessionAdvancedIpcResponse>;
      };
      data?: DataBridge;
      diagnostics?: {
        invoke(request: DiagnosticsIpcRequest): Promise<DiagnosticsIpcResponse>;
      };
      release?: ReleaseBridge;
    };
  }
}

let windowRequestSequence = 0;

function usbStatus(status: GatewayStatus | undefined): { label: string; tone: "success" | "warning" | "error" } {
  if (status === undefined) return { label: "U 盘检测中", tone: "warning" };
  if (status?.usb.state === "read-only") return { label: "U 盘只读", tone: "warning" };
  if (status?.usb.state === "missing") return { label: "U 盘未连接", tone: "error" };
  if (status?.usb.state === "error") return { label: "U 盘异常", tone: "error" };
  if (status.usb.dataWritable === false) return { label: "U 盘不可写", tone: "warning" };
  return { label: "U 盘可用", tone: "success" };
}

function gatewayStatus(status: GatewayStatus | undefined): { label: string; tone: "success" | "warning" | "error" } {
  if (status?.businessAvailable) return { label: "Gateway 已就绪", tone: "success" };
  if (status?.connectionState === "failed" || status?.phase === "failed") return { label: "Gateway 失败", tone: "error" };
  if (status?.connectionState === "degraded" || status?.phase === "degraded") return { label: "Gateway 异常", tone: "warning" };
  return { label: "Gateway 启动中", tone: "warning" };
}

function recoveryLabel(action: RecoveryAction): string {
  return {
    retry: "重试",
    reconnect: "重新连接",
    "open-settings": "打开设置",
    "open-diagnostics": "查看诊断",
    "safe-exit": "安全退出",
  }[action];
}

export function AppTitlebar({ status, onReconnect, onOpenActivity }: { status?: GatewayStatus; onReconnect(): Promise<void>; onOpenActivity(): void }) {
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
  const usb = usbStatus(status);
  const gateway = gatewayStatus(status);
  const recoveryActions = status?.error?.recoveryActions ?? [];

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
        <Tooltip title="打开任务活动中心"><button className="activity-center-trigger" type="button" aria-label="打开任务活动中心" onClick={onOpenActivity}><Activity /></button></Tooltip>
        <div className="runtime-status" aria-label="运行状态">
          <span className="status-item"><i className={`status-dot ${usb.tone}`} /><HardDrive aria-hidden="true" />{usb.label}</span>
          <span className="status-item"><i className={`status-dot ${gateway.tone}`} /><Radio aria-hidden="true" />{gateway.label}</span>
          <span className="model-status"><Cpu aria-hidden="true" />{status?.activeModel?.label ?? "模型加载中"}</span>
        </div>
        <div className="window-controls" aria-label="窗口控制">
          <Tooltip title="最小化"><button type="button" aria-label="最小化" onClick={() => void invokeWindow("minimize")}><Minus aria-hidden="true" /></button></Tooltip>
          <Tooltip title={isMaximized ? "还原" : "最大化"}><button type="button" aria-label={isMaximized ? "还原" : "最大化"} onClick={() => void invokeWindow("toggle-maximize")}>{isMaximized ? <Copy aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}</button></Tooltip>
          <Tooltip title="关闭"><button className="window-close" type="button" aria-label="关闭" onClick={() => void invokeWindow("close")}><X aria-hidden="true" /></button></Tooltip>
        </div>
        {windowError ? <div className="window-error" role="alert">{windowError}</div> : null}
        {status?.error ? <div className="runtime-recovery" role="alert"><strong>{status.error.message}</strong><span>错误码：{status.error.code}</span><div>{recoveryActions.map((action) => {
          if (action === "open-diagnostics" || action === "open-settings") return <Link key={action} to="/system">{recoveryLabel(action)}</Link>;
          if (action === "safe-exit") return <button key={action} type="button" onClick={() => void invokeWindow("close")}>{recoveryLabel(action)}</button>;
          return <button key={action} type="button" onClick={() => {
            void onReconnect().catch(() => setWindowError("重新连接失败，请重试"));
          }}><RotateCw aria-hidden="true" />{recoveryLabel(action)}</button>;
        })}</div></div> : null}
      </header>
      <Modal
        className="command-modal"
        closable={false}
        footer={null}
        keyboard
        maskClosable
        onCancel={closeSearch}
        open={searchOpen}
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
