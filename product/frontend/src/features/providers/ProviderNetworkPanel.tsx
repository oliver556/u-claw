import {
  ProviderNetworkSettingsSchema,
  type ProviderNetworkSettings,
} from "@uclaw/shared";
import { Alert, Button, Input } from "antd";
import { Save } from "lucide-react";
import { useEffect, useState } from "react";

export function ProviderNetworkPanel({
  network,
  onSave,
}: {
  network: ProviderNetworkSettings;
  onSave(network: ProviderNetworkSettings): Promise<boolean>;
}) {
  const [httpProxy, setHttpProxy] = useState("");
  const [httpsProxy, setHttpsProxy] = useState("");
  const [noProxy, setNoProxy] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"invalid" | "save-error" | "saved">();

  useEffect(() => {
    setHttpProxy(network.httpProxy ?? "");
    setHttpsProxy(network.httpsProxy ?? "");
    setNoProxy(network.noProxy.join(", "));
  }, [network]);

  const save = async () => {
    const parsed = ProviderNetworkSettingsSchema.safeParse({
      httpProxy: httpProxy.trim() || null,
      httpsProxy: httpsProxy.trim() || null,
      noProxy: noProxy.split(",").map((value) => value.trim()).filter(Boolean),
    });
    if (!parsed.success) {
      setStatus("invalid");
      return;
    }
    setBusy(true);
    setStatus(undefined);
    try {
      setStatus(await onSave(parsed.data) ? "saved" : "save-error");
    } finally {
      setBusy(false);
    }
  };

  return <section className="provider-tool" aria-labelledby="provider-network-title">
    <header><div><h2 id="provider-network-title">网络代理</h2><span>HTTP / HTTPS</span></div></header>
    <div className="provider-network-form">
      <label>HTTP 代理<Input aria-label="HTTP 代理" placeholder="http://proxy.example.com:8080" value={httpProxy} onChange={(event) => setHttpProxy(event.target.value)} /></label>
      <label>HTTPS 代理<Input aria-label="HTTPS 代理" placeholder="https://proxy.example.com:8443" value={httpsProxy} onChange={(event) => setHttpsProxy(event.target.value)} /></label>
      <label>NO_PROXY<Input aria-label="NO_PROXY" value={noProxy} onChange={(event) => setNoProxy(event.target.value)} /></label>
    </div>
    <div className="provider-tool-footer">
      <span>本地服务默认直连；SOCKS 当前不可用</span>
      <Button type="primary" icon={<Save />} loading={busy} aria-label="保存代理设置" onClick={() => void save()}>保存</Button>
    </div>
    {status === "invalid" ? <Alert type="error" showIcon message="代理地址无效；仅支持不含凭据的 HTTP/HTTPS 地址" /> : null}
    {status === "save-error" ? <Alert type="error" showIcon message="代理设置保存失败，请检查 Gateway 状态后重试" /> : null}
    {status === "saved" ? <Alert type="success" showIcon message="代理设置已保存" /> : null}
  </section>;
}
