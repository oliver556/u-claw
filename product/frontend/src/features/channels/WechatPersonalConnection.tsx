import type { ChannelIpcRequest, WechatConnectionSnapshot } from "@uclaw/shared";
import { Alert, Button, Popconfirm, Tag } from "antd";
import { LogOut, QrCode, RefreshCw, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

let requestSequence = 0;
function request(method: ChannelIpcRequest["method"], params: Record<string, unknown>): ChannelIpcRequest {
  requestSequence += 1;
  return { method, requestId: `wechat-ui-${requestSequence}`, params } as ChannelIpcRequest;
}

const loginLabels: Record<WechatConnectionSnapshot["loginState"], string> = {
  idle: "未登录", preparing: "正在生成二维码", "awaiting-scan": "等待扫码",
  "awaiting-confirmation": "扫码后请在手机微信确认", connected: "已连接",
  expired: "二维码已过期", cancelled: "已取消", "logged-out": "已退出", error: "需要操作",
};

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
  const connected = snapshot?.loginState === "connected";
  const activeQr = Boolean(snapshot?.flowId && snapshot.qrGeneration);
  const qrDataUrl = snapshot?.qrImage?.kind === "data-url" ? snapshot.qrImage.value : undefined;
  const refresh = () => snapshot?.flowId && snapshot.qrGeneration && void run("channels.wechat-login-refresh", { flowId: snapshot.flowId, qrGeneration: snapshot.qrGeneration });
  const cancel = () => snapshot?.flowId && void run("channels.wechat-login-cancel", { flowId: snapshot.flowId });

  return <section className="wechat-connection" aria-label="个人微信连接">
    <div className="wechat-connection-head">
      <div className="channel-icon"><QrCode /></div>
      <div className="wechat-identity"><div><strong>个人微信</strong><Tag>扫码登录</Tag></div><span>@tencent-weixin/openclaw-weixin@2.4.6</span></div>
      <Tag color={snapshot?.status === "connected" ? "success" : snapshot?.status === "network-error" ? "error" : "gold"}>{loading ? "检查中" : snapshot ? loginLabels[snapshot.loginState] : "离线"}</Tag>
    </div>

    {bridgeError ? <Alert type="error" showIcon message="个人微信状态暂不可用" description="本地 runtime 未就绪或连接中断。" action={<Button size="small" onClick={() => void run("channels.wechat-status")}>重试</Button>} /> : null}
    {snapshot?.capability === "unavailable" ? <Alert type="warning" showIcon message={snapshot.error?.code === "WECHAT_PLUGIN_MISSING" ? "个人微信插件未安装" : "Capability unavailable"} description={snapshot.capabilityReason ?? snapshot.error?.message} /> : null}

    {snapshot && available ? <div className="wechat-body">
      {activeQr ? <div className="wechat-qr-stage">
        <div className="wechat-qr-frame">{qrDataUrl ? <img src={qrDataUrl} alt="个人微信登录二维码" /> : <div className="wechat-qr-placeholder"><QrCode /><span>二维码资源不可显示</span></div>}</div>
        <div className="wechat-qr-copy"><strong>{loginLabels[snapshot.loginState]}</strong><span>{snapshot.qrExpiresAt ? `有效期至 ${new Date(snapshot.qrExpiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "请使用手机微信完成操作"}</span><div className="wechat-actions"><Button icon={<RefreshCw />} disabled={busy} onClick={refresh}>刷新二维码</Button><Button icon={<X />} disabled={busy} onClick={cancel}>取消</Button></div></div>
      </div> : <div className="wechat-account">
        <div><strong>{snapshot.account?.displayName ?? "个人微信账号"}</strong><span>{snapshot.account?.accountIdHint ?? "账号信息仅保存在当前 U 盘"}</span></div>
        <div className="wechat-actions">{connected ? <Button icon={<RotateCw />} disabled={busy} onClick={() => void run("channels.wechat-reconnect")}>重新连接</Button> : null}{connected ? <Popconfirm title="退出个人微信？" description="当前 U 盘中的个人微信账号状态与凭据将被清理。" okText="退出" cancelText="取消" onConfirm={() => void run("channels.wechat-logout")}><Button danger icon={<LogOut />} disabled={busy}>退出登录</Button></Popconfirm> : <Button type="primary" icon={<QrCode />} aria-label="开始个人微信扫码登录" disabled={busy || !available} onClick={() => void run("channels.wechat-login-start", { force: false })}>扫码登录</Button>}</div>
      </div>}
      {snapshot.error ? <Alert type={snapshot.error.category === "network" || snapshot.error.category === "timeout" ? "error" : "warning"} showIcon message={snapshot.error.message} action={snapshot.loginState === "expired" && activeQr ? <Button size="small" onClick={refresh}>刷新</Button> : undefined} /> : null}
    </div> : null}

    {!loading && snapshot?.capability === "unavailable" ? <div className="wechat-unavailable-action"><Button type="primary" icon={<QrCode />} aria-label="开始个人微信扫码登录" disabled>扫码登录</Button><span>插件安装与兼容修复后可用</span></div> : null}
  </section>;
}
