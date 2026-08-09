import type { CapabilityRisk, PluginCatalogItem, PluginOperation } from "@uclaw/shared";
import { Download, RefreshCw, Trash2 } from "lucide-react";

const riskLabel: Record<CapabilityRisk, string> = { low: "低风险", medium: "中风险", high: "高风险", critical: "严重风险" };
const permissionKindLabel = { filesystem: "文件", network: "网络", command: "命令", environment: "环境变量" } as const;
const availabilityLabel = { available: "可用", installable: "可安装", unpackaged: "未打包", incompatible: "不兼容" } as const;

export function PluginCard({
  item,
  operation,
  onConfirm,
  onDisable,
  onUninstall,
}: {
  item: PluginCatalogItem;
  operation?: PluginOperation;
  onConfirm(action: "install" | "update" | "enable"): void;
  onDisable(): void;
  onUninstall(): void;
}) {
  const busy = operation?.state === "queued" || operation?.state === "running";
  const installBlocked = item.availability === "unpackaged" || item.availability === "incompatible";
  return <article className="plugin-row">
    <div className="plugin-identity">
      <div><strong>{item.name}</strong><span className={`risk-${item.risk}`}>{riskLabel[item.risk]}</span><span className={`plugin-availability ${item.availability}`}>{availabilityLabel[item.availability]}</span></div>
      <p>{item.description}</p>
      <small>{item.slug} · v{item.version} · OpenClaw {item.compatibility.openClawVersion}</small>
      {item.compatibility.reason ? <small className="plugin-compatibility">{item.compatibility.reason}</small> : null}
    </div>
    <div className="plugin-permissions">
      {item.permissions.map((permission) => <span key={`${permission.kind}-${permission.target}`}>{permissionKindLabel[permission.kind]} · {permission.target}</span>)}
      {item.nativeCode ? <span className="plugin-danger">原生代码</span> : null}
      {item.commandExecution ? <span className="plugin-danger">命令执行</span> : null}
      <span>{item.integrityVerified ? "SHA-256 已验证" : "完整性未验证"}</span>
      <span>{item.source.provider === "external" ? "外置渠道" : item.source.provider === "bundled" ? "随 runtime 打包" : "Fixture 来源"}</span>
    </div>
    <div className="plugin-actions">
      {item.installedVersion === null ? <button type="button" aria-label={`安装 ${item.name}`} disabled={busy || installBlocked} onClick={() => onConfirm("install")}><Download />安装</button> : <>
        {item.updateAvailable ? <button type="button" aria-label={`更新 ${item.name}`} disabled={busy} onClick={() => onConfirm("update")}><RefreshCw />更新</button> : null}
        <label className="plugin-switch"><input type="checkbox" role="switch" aria-label={`${item.enabled ? "禁用" : "启用"} ${item.name}`} checked={item.enabled} disabled={busy} onChange={() => item.enabled ? onDisable() : onConfirm("enable")} /><span>{item.enabled ? "已启用" : "已禁用"}</span></label>
        {item.managedByUClaw ? <button type="button" aria-label={`卸载 ${item.name}`} disabled={busy} onClick={onUninstall}><Trash2 />卸载</button> : null}
      </>}
    </div>
    {operation ? <div className={`plugin-progress ${operation.state}`}><progress aria-label={`${item.name}操作进度`} aria-valuenow={operation.progress} value={operation.progress} max="100" /><span>{operation.progress}%</span><span>{operation.state === "failed" ? "失败，可重试" : operation.state === "succeeded" ? "完成" : "处理中"}</span></div> : null}
  </article>;
}
