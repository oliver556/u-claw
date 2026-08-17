import type { ChannelIpcRequest, WechatConnectionSnapshot } from "@uclaw/shared";
import { Alert, Button, Popconfirm, Tag } from "antd";
import { LogOut, QrCode, RefreshCw, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

let requestSequence = 0;
function request(method: ChannelIpcRequest["method"], params: Record<string, unknown>): ChannelIpcRequest {
  requestSequence += 1;
  return { method, requestId: `wechat-ui-${requestSequence}`, params } as ChannelIpcRequest;
}

type BusinessState = {
  label: string;
  color?: "error" | "gold" | "success";
  description?: string;
};

function unavailableState(snapshot: WechatConnectionSnapshot): BusinessState {
  switch (snapshot.error?.code) {
    case "WECHAT_PLUGIN_MISSING":
      return { label: "组件缺失，需修复 U-Claw", color: "error", description: "请修复或更新 U-Claw 后重试。" };
    case "WECHAT_PLUGIN_UPDATING":
      return { label: "组件更新中", color: "gold", description: "更新完成后即可扫码连接。" };
    case "WECHAT_PLUGIN_REPAIRING":
      return { label: "组件修复中", color: "gold", description: "修复完成后即可扫码连接。" };
    default:
      return { label: "组件损坏，需修复或更新 U-Claw", color: "error", description: "请修复或更新 U-Claw 后重试。" };
  }
}

function businessState(snapshot: WechatConnectionSnapshot | undefined, loading: boolean, bridgeError: boolean): BusinessState {
  if (loading) return { label: "检查中", color: "gold" };
  if (bridgeError || !snapshot) return { label: "连接中断，可重连", color: "error", description: "请稍后重试。" };
  if (snapshot.capability === "unavailable") return unavailableState(snapshot);
  if (snapshot.status === "auth-failed" || snapshot.error?.code === "WECHAT_LOGGED_OUT") {
    return { label: "授权失效，需重新扫码", color: "error", description: "请重新扫码并在手机微信确认。" };
  }
  if (snapshot.status === "network-error" || (snapshot.status === "disconnected" && snapshot.account)) {
    return { label: "连接中断，可重连", color: "error", description: "请检查网络后重新连接。" };
  }
  switch (snapshot.loginState) {
    case "preparing": return { label: "检查中", color: "gold" };
    case "awaiting-scan": return { label: "等待扫码", color: "gold" };
    case "awaiting-confirmation": return { label: "已扫码，等待手机确认", color: "gold" };
    case "connected": return { label: "已连接", color: "success" };
    case "expired": return { label: "二维码已过期", color: "error", description: "请刷新二维码后重试。" };
    case "error": return { label: "连接失败，请重试", color: "error", description: "请稍后重试。" };
    default: return { label: "可扫码连接", color: "gold" };
  }
}

export function WechatPersonalConnection() {
  const invoke = window.uclaw?.channels?.invoke;
  const [snapshot, setSnapshot] = useState<WechatConnectionSnapshot>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [bridgeError, setBridgeError] = useState(false);

  const run = useCallback(async (method: ChannelIpcRequest["method"], params: Record<string, unknown> = {}) => {
    if (!invoke || busy) return;
    setBusy(true);
    setBridgeError(false);
    try {
      const response = await invoke(request(method, params));
      if (!response.ok || response.method !== method || !response.method.startsWith("channels.wechat-")) throw new Error();
      setSnapshot(response.result as WechatConnectionSnapshot);
    } catch {
      setBridgeError(true);
    } finally {
      setBusy(false);
      setLoading(false);
    }
  }, [busy, invoke]);

  useEffect(() => { void run("channels.wechat-status"); }, [invoke]);
  useEffect(() => {
    if (!snapshot?.flowId || !snapshot.qrGeneration || busy) return;
    if (snapshot.loginState !== "awaiting-scan" && snapshot.loginState !== "awaiting-confirmation") return;
    const timer = window.setTimeout(() => {
      void run("channels.wechat-login-poll", { flowId: snapshot.flowId, qrGeneration: snapshot.qrGeneration });
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [busy, run, snapshot]);

  const available = snapshot?.capability === "available";
  const hasAccount = snapshot?.account !== undefined;
  const activeQr = Boolean(snapshot?.flowId && snapshot.qrGeneration);
  const qrDataUrl = snapshot?.qrImage?.kind === "data-url" ? snapshot.qrImage.value : undefined;
  const qrHint = snapshot?.loginState === "awaiting-confirmation"
    ? "扫码后请在手机微信确认"
    : snapshot?.loginState === "awaiting-scan"
      ? "请使用手机微信扫码"
      : snapshot?.loginState === "expired"
        ? "二维码已过期，请刷新后重试。"
        : "请使用手机微信完成操作";
  const state = businessState(snapshot, loading, bridgeError);
  const needsRescan = snapshot?.status === "auth-failed" || snapshot?.error?.code === "WECHAT_LOGGED_OUT";
  const refresh = () => snapshot?.flowId && snapshot.qrGeneration && void run("channels.wechat-login-refresh", { flowId: snapshot.flowId, qrGeneration: snapshot.qrGeneration });
  const cancel = () => snapshot?.flowId && void run("channels.wechat-login-cancel", { flowId: snapshot.flowId });

  return <section className="wechat-connection" aria-label="个人微信连接">
    <div className="wechat-connection-head">
      <div className="channel-icon"><QrCode /></div>
      <div className="wechat-identity"><div><strong>个人微信</strong><Tag>扫码登录</Tag></div><span>通过手机微信扫码连接</span></div>
      <Tag color={state.color}>{state.label}</Tag>
    </div>

    {bridgeError ? <Alert type="error" showIcon message={state.label} description={state.description} action={<Button size="small" onClick={() => void run("channels.wechat-status")}>重试</Button>} /> : null}
    {snapshot?.capability === "unavailable" ? <Alert type={state.color === "error" ? "error" : "warning"} showIcon message={state.label} description={state.description} /> : null}

    {snapshot && available ? <div className="wechat-body">
      {activeQr ? <div className="wechat-qr-stage">
        <div className="wechat-qr-frame">{qrDataUrl ? <img src={qrDataUrl} alt="个人微信登录二维码" /> : <div className="wechat-qr-placeholder"><QrCode /><span>二维码资源不可显示</span></div>}</div>
        <div className="wechat-qr-copy"><strong>{state.label}</strong><span>{qrHint}</span><span>{snapshot.qrExpiresAt ? `有效期至 ${new Date(snapshot.qrExpiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "请使用手机微信完成操作"}</span><div className="wechat-actions"><Button icon={<RefreshCw />} disabled={busy} onClick={refresh}>刷新二维码</Button><Button icon={<X />} disabled={busy} onClick={cancel}>取消</Button></div></div>
      </div> : <div className="wechat-account">
        <div><strong>{hasAccount ? "已连接微信账号" : "个人微信账号"}</strong><span>{snapshot.account?.accountIdHint ?? "账号信息仅保存在当前 U 盘"}</span></div>
        <div className="wechat-actions">{needsRescan ? <Button type="primary" icon={<QrCode />} disabled={busy} onClick={() => void run("channels.wechat-login-start", { force: true })}>重新扫码</Button> : hasAccount ? <Button icon={<RotateCw />} disabled={busy} onClick={() => void run("channels.wechat-reconnect")}>重新连接</Button> : <Button type="primary" icon={<QrCode />} aria-label="开始个人微信扫码登录" disabled={busy || !available} onClick={() => void run("channels.wechat-login-start", { force: false })}>扫码登录</Button>}{hasAccount ? <Popconfirm title="退出个人微信？" description="当前 U 盘中的个人微信账号状态与凭据将被清理。" okText="退出" cancelText="取消" onConfirm={() => void run("channels.wechat-logout")}><Button danger icon={<LogOut />} disabled={busy}>退出登录</Button></Popconfirm> : null}</div>
      </div>}
      {snapshot.error ? <Alert type={state.color === "error" ? "error" : "warning"} showIcon message={state.label} description={state.description} action={snapshot.loginState === "expired" && activeQr ? <Button size="small" onClick={refresh}>刷新</Button> : undefined} /> : null}
    </div> : null}

    {!loading && snapshot?.capability === "unavailable" ? <div className="wechat-unavailable-action"><Button type="primary" icon={<QrCode />} aria-label="开始个人微信扫码登录" disabled>扫码登录</Button><span>组件恢复后可扫码连接</span></div> : null}
  </section>;
}
