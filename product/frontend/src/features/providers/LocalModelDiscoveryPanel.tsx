import type { LocalModelDiscovery, ProviderIpcRequest, ProviderIpcResponse } from "@uclaw/shared";
import { Alert, Button } from "antd";
import { RefreshCw, Square } from "lucide-react";
import { useRef, useState } from "react";

type Invoke = (request: ProviderIpcRequest) => Promise<ProviderIpcResponse>;

export function LocalModelDiscoveryPanel({
  invoke,
  onUse,
}: {
  invoke?: Invoke;
  onUse(model: LocalModelDiscovery["models"][number]): Promise<void>;
}) {
  const sequence = useRef(0);
  const [result, setResult] = useState<LocalModelDiscovery>();
  const [activeRequestId, setActiveRequestId] = useState<string>();
  const [error, setError] = useState(false);

  const refresh = async () => {
    if (!invoke || activeRequestId) return;
    const requestId = `provider-discovery-${++sequence.current}`;
    setActiveRequestId(requestId);
    setError(false);
    try {
      const response = await invoke({ method: "providers.discover-local", requestId, params: {} });
      if (!response.ok || response.method !== "providers.discover-local") throw new Error();
      setResult(response.result);
    } catch {
      setError(true);
    } finally {
      setActiveRequestId(undefined);
    }
  };

  const cancel = async () => {
    if (!invoke || !activeRequestId) return;
    await invoke({
      method: "providers.cancel",
      requestId: `provider-discovery-cancel-${++sequence.current}`,
      params: { operationRequestId: activeRequestId },
    }).catch(() => undefined);
  };

  return <section className="provider-tool" aria-labelledby="local-model-title">
    <header>
      <div><h2 id="local-model-title">本地模型</h2><span>Ollama / LM Studio</span></div>
      {activeRequestId
        ? <Button icon={<Square />} aria-label="取消本地模型发现" onClick={() => void cancel()}>取消</Button>
        : <Button icon={<RefreshCw />} aria-label="刷新本地模型" onClick={() => void refresh()}>刷新</Button>}
    </header>
    {error ? <Alert type="error" showIcon message="本地模型发现失败" action={<Button size="small" onClick={() => void refresh()}>重试</Button>} /> : null}
    {activeRequestId ? <div className="provider-inline-state"><RefreshCw className="spin" />正在探测本地服务</div> : null}
    {!activeRequestId && result?.state === "empty" ? <div className="provider-inline-state">未发现本地模型</div> : null}
    {result?.models.length ? <div className="local-model-list">
      {result.models.map((model) => <div className="local-model-row" key={`${model.source}:${model.id}`}>
        <div><strong>{model.label}</strong><span>{model.source === "ollama" ? "Ollama" : "LM Studio"}</span></div>
        <Button size="small" aria-label={`使用 ${model.label}`} onClick={() => void onUse(model)}>使用</Button>
      </div>)}
    </div> : null}
  </section>;
}
