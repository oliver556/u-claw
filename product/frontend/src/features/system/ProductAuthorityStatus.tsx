import type { ProductAuthorityIpcRequest, ProductAuthorityIpcResponse, ProductAuthoritySummary } from "@uclaw/shared";
import { CircleAlert, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type Bridge = { readAuthority(request: ProductAuthorityIpcRequest): Promise<ProductAuthorityIpcResponse> };

export function ProductAuthorityStatus({ bridge }: { bridge?: Bridge }) {
  const sequence = useRef(0);
  const [summary, setSummary] = useState<ProductAuthoritySummary>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!bridge) { setError("PRODUCT_SERVICES_NOT_CONFIGURED"); return; }
    setLoading(true); setError(undefined);
    try {
      const response = await bridge.readAuthority({ method: "product.authority.read", requestId: `product-authority-${++sequence.current}`, params: {} });
      if (!response.ok) { setError(response.error.code); setSummary(undefined); return; }
      setSummary(response.result);
    } catch {
      setError("PRODUCT_AUTHORITY_UNAVAILABLE"); setSummary(undefined);
    } finally { setLoading(false); }
  }, [bridge]);
  useEffect(() => { void load(); }, [load]);

  return <section className="system-node-manager" aria-label="产品授权" aria-busy={loading}>
    <header className="data-toolbar"><strong>产品授权与服务状态</strong><button type="button" aria-label="刷新产品授权" disabled={loading} onClick={() => void load()}><RefreshCw /></button></header>
    {error ? <div role="alert" className="data-state"><CircleAlert /><strong>授权状态不可用</strong><small>{error}</small></div> : null}
    {summary ? <div className="system-node-content"><div className="system-node-list">
      <article><ShieldCheck /><span><strong>{summary.license.status === "active" ? "授权有效" : `授权状态：${summary.license.status}`}</strong><small>修订 {summary.license.revision} · 有效期至 {new Date(summary.license.expiresAt).toLocaleDateString("zh-CN")}</small></span></article>
      <article><span><strong>产品服务 {summary.service.state === "enabled" ? "已启用" : "已停用"}</strong><small>{summary.service.reasonCode} · 修订 {summary.service.revision}</small></span></article>
      <article><span><strong>{summary.usage.consumed} / {summary.policy.quota.limit} {summary.policy.quota.unit}</strong><small>剩余 {summary.usage.remaining} · {summary.policy.rateLimit.requestsPerMinute} RPM · 并发 {summary.policy.rateLimit.concurrentRequests}</small></span></article>
      <article><span><strong>可用模型 {summary.policy.allowedModels.length}</strong><small>{summary.product.userStatus === "active" && !summary.policy.disabled ? "用户与策略有效" : "用户或策略已停用"} · generation {summary.product.generation}</small></span></article>
    </div></div> : null}
  </section>;
}
