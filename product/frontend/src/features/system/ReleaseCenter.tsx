import type { ReleaseBridge, ReleaseCheckResult, ReleaseIpcRequest, ReleaseOperation, UninstallPreview } from "@uclaw/shared";
import { AlertTriangle, CheckCircle2, Download, LoaderCircle, RefreshCw, ShieldCheck, SquareTerminal, Stethoscope, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

let sequence = 0;
const requestId = (method: string) => `release-${method}-${Date.now()}-${++sequence}`;
const unavailableBridge: ReleaseBridge = { async invoke(request) { return { method: request.method, requestId: request.requestId, ok: false, error: { code: "UNAVAILABLE", message: "发布服务未配置。", retryable: false, recoveryActions: [], causeDetails: {} } } as any; } };

export function ReleaseCenter({ bridge, onOpenDiagnostics }: { bridge?: ReleaseBridge; onOpenDiagnostics(): void }) {
  const resolved = bridge ?? window.uclaw?.release ?? unavailableBridge;
  const [tab, setTab] = useState<"updates" | "uninstall">("updates");
  const [channel, setChannel] = useState<"stable" | "beta">("stable");
  const [checking, setChecking] = useState(true);
  const [result, setResult] = useState<ReleaseCheckResult>();
  const [preview, setPreview] = useState<UninstallPreview>();
  const [operation, setOperation] = useState<ReleaseOperation>();
  const [confirm, setConfirm] = useState<"install" | "uninstall">();
  const [error, setError] = useState<string>();
  const [recovery, setRecovery] = useState<{ state: "clean" | "rolled-back" | "recovery-required"; message: string }>();
  const invoke = useCallback(async (request: ReleaseIpcRequest) => {
    const response = await resolved.invoke(request);
    if (response.method !== request.method || response.requestId !== request.requestId) throw new Error("发布服务响应关联失败。");
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  }, [resolved]);
  const check = useCallback(async (retry = false) => {
    setChecking(true); setError(undefined);
    try { setResult(await invoke(retry ? { method: "release.retry", requestId: requestId("retry"), params: {} } : { method: "release.check", requestId: requestId("check"), params: { channel } }) as ReleaseCheckResult); }
    catch (caught) { setResult({ state: "unavailable", checkedAt: new Date().toISOString(), currentVersion: "未知", channel, retryable: false, message: caught instanceof Error ? caught.message : "发布服务不可用。" }); }
    finally { setChecking(false); }
  }, [channel, invoke]);
  useEffect(() => { void check(); }, [check]);
  useEffect(() => { void invoke({ method: "release.recovery", requestId: requestId("recovery"), params: {} }).then((value) => setRecovery(value as typeof recovery)).catch((caught) => setError(caught instanceof Error ? caught.message : "更新恢复检查失败。")); }, [invoke]);
  useEffect(() => {
    if (!operation || !["queued", "running"].includes(operation.state)) return;
    const timer = window.setInterval(() => void invoke({ method: "release.operation", requestId: requestId("operation"), params: { operationId: operation.id } }).then((value) => setOperation(value as ReleaseOperation)).catch((caught) => { setError(caught instanceof Error ? caught.message : "更新进度读取失败。"); setOperation((current) => current ? { ...current, state: "failed", phase: "failed", message: "更新进度读取失败。", recovery: "recovery-required" } : current); }), 300);
    return () => window.clearInterval(timer);
  }, [invoke, operation]);
  const openUninstall = async () => { setTab("uninstall"); if (!preview) try { setPreview(await invoke({ method: "uninstall.preview", requestId: requestId("uninstall-preview"), params: {} }) as UninstallPreview); } catch (caught) { setError(caught instanceof Error ? caught.message : "卸载预览失败。"); } };
  const execute = async () => {
    const action = confirm; setConfirm(undefined); if (!action) return;
    try {
      if (action === "install" && result?.update) setOperation(await invoke({ method: "release.install", requestId: requestId("install"), params: { updateId: result.update.id, previewToken: result.update.previewToken, confirmed: true } }) as ReleaseOperation);
      if (action === "uninstall" && preview) setOperation(await invoke({ method: "uninstall.execute", requestId: requestId("uninstall"), params: { scopeIds: ["host-cache"], previewToken: preview.previewToken, confirmed: true } }) as ReleaseOperation);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "操作失败。"); }
  };
  const stateText = result?.state === "offline" ? "当前离线，无法检查更新" : result?.state === "unavailable" ? "更新服务不可用" : result?.state === "timeout" ? "更新检查超时" : result?.state === "cancelled" ? "更新检查已取消" : result?.state === "current" ? "当前已是最新版本" : "未发现更新";
  const openCli = () => void window.uclaw?.window?.invoke?.({ method: "open-advanced-console", requestId: requestId("console"), params: {} });
  const cancelCheck = async () => { try { setResult(await invoke({ method: "release.cancel-check", requestId: requestId("cancel-check"), params: {} }) as ReleaseCheckResult); } finally { setChecking(false); } };
  const cancelOperation = async () => { if (operation) setOperation(await invoke({ method: "release.cancel", requestId: requestId("cancel"), params: { operationId: operation.id } }) as ReleaseOperation); };
  return <section className="release-center secondary-view">
    <header><div><h1>发布与恢复</h1><p>签名更新、Doctor 入口与受控卸载</p></div><div className="release-head-actions">{checking ? <button className="secondary-command" type="button" onClick={() => void cancelCheck()}><X />取消检查</button> : null}<button className="secondary-command" type="button" onClick={onOpenDiagnostics}><Stethoscope />打开 Doctor</button><button className="secondary-command" type="button" onClick={openCli}><SquareTerminal />打开 CLI 控制台</button></div></header>
    <div className="release-tabs" role="tablist" aria-label="发布工具"><button type="button" role="tab" aria-selected={tab === "updates"} onClick={() => setTab("updates")}><Download />更新</button><button type="button" role="tab" aria-selected={tab === "uninstall"} onClick={() => void openUninstall()}><Trash2 />卸载与清理</button></div>
    {error ? <div className="data-error" role="alert">{error}</div> : null}
    {recovery && recovery.state !== "clean" ? <div className={`release-recovery ${recovery.state}`} role="alert"><AlertTriangle />{recovery.message}</div> : null}
    <div className="release-content">
      {tab === "updates" ? <>{checking ? <div className="data-state"><LoaderCircle className="spin" /><strong>正在检查更新</strong></div> : result?.update ? <section className="release-update"><header><div><span>版本</span><strong>{result.update.version}</strong></div><em>{result.update.channel}</em></header><dl><div><dt>发布时间</dt><dd>{new Date(result.update.publishedAt).toLocaleString()}</dd></div><div><dt>兼容性</dt><dd>{result.update.compatibility.platform} · {result.update.compatibility.arch}</dd></div><div><dt>Runtime</dt><dd>{result.update.compatibility.runtimeId}</dd></div></dl><ul>{result.update.notes.map((note) => <li key={note}>{note}</li>)}</ul><div className="release-trust"><ShieldCheck />签名清单、版本绑定与校验和将在安装前验证</div><button type="button" onClick={() => setConfirm("install")}><Download />安装更新</button></section> : <div className="data-state"><AlertTriangle /><strong>{stateText}</strong>{result?.message ? <small>{result.message}</small> : null}{result?.retryable ? <button type="button" onClick={() => void check(true)}><RefreshCw />重试</button> : null}</div>}
      <label className="release-channel">更新渠道<select value={channel} onChange={(event) => setChannel(event.target.value as "stable" | "beta")}><option value="stable">Stable</option><option value="beta">Beta</option></select></label></> : <section className="uninstall-preview"><h2>卸载范围</h2>{preview ? preview.scopes.map((scope) => <div key={scope.id} className={scope.protected ? "protected" : ""}><span><strong>{scope.label}</strong><small>{scope.detail}</small></span>{scope.protected ? <ShieldCheck /> : scope.available ? <CheckCircle2 /> : <X />}</div>) : <div className="data-state"><LoaderCircle className="spin" /></div>}<button type="button" disabled={!preview} onClick={() => setConfirm("uninstall")}><Trash2 />清理本机缓存</button></section>}
    </div>
    {operation ? <aside className={`maintenance-operation ${operation.state}`}><div>{operation.state === "completed" ? <CheckCircle2 /> : operation.state === "failed" ? <AlertTriangle /> : <LoaderCircle className="spin" />}<span><strong>{operation.message}</strong><small>{operation.processedItems}/{operation.totalItems} 项{operation.partialFailures ? ` · ${operation.partialFailures} 项失败` : ""}{operation.recovery !== "none" ? ` · ${operation.recovery}` : ""}</small></span></div>{operation.kind === "install" && ["queued", "downloading", "verifying"].includes(operation.phase) ? <button type="button" onClick={() => void cancelOperation()}><X />取消</button> : null}</aside> : null}
    {confirm ? <div className="data-modal-backdrop"><div className="data-modal" role="dialog" aria-modal="true" aria-label={confirm === "install" ? "确认安装更新" : "确认清理本机缓存"}><h2>{confirm === "install" ? "确认安装更新" : "确认清理本机缓存"}</h2><p>{confirm === "install" ? "下载仅进入受控暂存区；验签和校验通过后原子切换，失败自动回滚。" : "只清理 marker 证明归属的本机 U-Claw 缓存；U 盘用户数据保持不变。"}</p><div className="data-confirm-actions"><button type="button" onClick={() => setConfirm(undefined)}>取消</button><button type="button" onClick={() => void execute()}>{confirm === "install" ? "确认安装" : "确认清理"}</button></div></div></div> : null}
  </section>;
}
