import type {
  BackupCollectionId,
  BackupPreview,
  BackupSummary,
  CleanupCandidateId,
  CleanupPreview,
  DataBridge,
  DataIpcRequest,
  MaintenanceOperation,
  RestorePreview,
  StorageStats,
} from "@uclaw/shared";
import { AlertTriangle, Archive, CheckCircle2, DatabaseBackup, HardDrive, LoaderCircle, RefreshCw, RotateCcw, SquareTerminal, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type Tab = "backup" | "restore" | "storage";
type Availability = "checking" | "available" | "read-only" | "offline" | "damaged";
type Confirmation = { kind: "backup" | "restore" | "cleanup"; title: string; body: string };

let requestSequence = 0;
const requestId = (method: string) => `maintenance-${method}-${Date.now()}-${++requestSequence}`;
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;

const unavailableBridge: DataBridge = {
  async invoke(request) {
    if (request.method === "data.status") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "offline", writable: false } };
    return { method: request.method, requestId: request.requestId, ok: false, error: { code: "UNAVAILABLE", message: "原生维护服务未连接。", retryable: true, recoveryActions: ["retry"], causeDetails: {} } };
  },
};

export function MaintenanceCenter({ bridge }: { bridge?: DataBridge }) {
  const resolvedBridge = bridge ?? window.uclaw?.data ?? unavailableBridge;
  const [tab, setTab] = useState<Tab>("backup");
  const [availability, setAvailability] = useState<Availability>("checking");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [backupPreview, setBackupPreview] = useState<BackupPreview>();
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [selectedCollections, setSelectedCollections] = useState<BackupCollectionId[]>([]);
  const [restorePreview, setRestorePreview] = useState<RestorePreview>();
  const [storage, setStorage] = useState<StorageStats>();
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview>();
  const [selectedCleanup, setSelectedCleanup] = useState<CleanupCandidateId[]>([]);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [operation, setOperation] = useState<MaintenanceOperation>();

  const invoke = useCallback(async (request: DataIpcRequest) => {
    const response = await resolvedBridge.invoke(request);
    if (response.method !== request.method || response.requestId !== request.requestId) throw new Error("维护服务响应关联失败。");
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  }, [resolvedBridge]);

  const load = useCallback(async () => {
    setLoading(true); setError(undefined);
    try {
      const status = await invoke({ method: "data.status", requestId: requestId("status"), params: {} }) as { state: Availability; writable: boolean };
      setAvailability(status.state);
      const [preview, list, stats, cleanup] = await Promise.all([
        invoke({ method: "backup.preview", requestId: requestId("backup-preview"), params: {} }),
        invoke({ method: "backup.list", requestId: requestId("backup-list"), params: {} }),
        invoke({ method: "storage.stats", requestId: requestId("storage-stats"), params: {} }),
        invoke({ method: "cleanup.preview", requestId: requestId("cleanup-preview"), params: {} }),
      ]);
      const parsedPreview = preview as BackupPreview;
      const parsedCleanup = cleanup as CleanupPreview;
      const parsedStorage = stats as StorageStats;
      setBackupPreview(parsedPreview); setSelectedCollections(parsedPreview.collections.map((item) => item.id));
      setBackups((list as { items: BackupSummary[] }).items);
      setStorage(parsedStorage); if (parsedStorage.state === "damaged") setAvailability("damaged");
      setCleanupPreview(parsedCleanup); setSelectedCleanup(parsedCleanup.candidates.map((item) => item.id));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "维护数据加载失败。"); }
    finally { setLoading(false); }
  }, [invoke]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!operation || !["queued", "running"].includes(operation.state)) return;
    const timer = window.setInterval(() => {
      void invoke({ method: "maintenance.operation-get", requestId: requestId("operation"), params: { operationId: operation.id } })
        .then((value) => setOperation(value as MaintenanceOperation)).catch((caught) => setError(caught instanceof Error ? caught.message : "进度读取失败。"));
    }, 300);
    return () => window.clearInterval(timer);
  }, [invoke, operation]);

  const writable = availability === "available";
  const coordinated = backupPreview?.consistency === "coordinated";
  const busy = operation?.state === "queued" || operation?.state === "running";
  const statusLabel = availability === "checking" ? "正在检查 U 盘" : availability === "available" ? "U 盘可用" : availability === "read-only" ? "U 盘只读" : availability === "offline" ? "U 盘离线" : "存储损坏";

  const refreshBackupPreview = async (collections = selectedCollections) => {
    if (collections.length === 0) return;
    try {
      const result = await invoke({ method: "backup.preview", requestId: requestId("backup-preview"), params: { collectionIds: collections, trigger: backupPreview?.trigger ?? "manual", retainLatest: backupPreview?.retainLatest ?? 3 } });
      setBackupPreview(result as BackupPreview);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "备份预览失败。"); }
  };

  const selectBackup = async (backup: BackupSummary) => {
    setError(undefined); setRestorePreview(undefined);
    try {
      const result = await invoke({ method: "backup.restore-preview", requestId: requestId("restore-preview"), params: { backupId: backup.id, collectionIds: backup.collections } });
      setRestorePreview(result as RestorePreview);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "恢复预览失败。"); }
  };

  const executeConfirmed = async () => {
    const current = confirmation; setConfirmation(undefined); setError(undefined);
    if (!current) return;
    try {
      let result: unknown;
      if (current.kind === "backup" && backupPreview) result = await invoke({ method: "backup.create", requestId: requestId("backup-create"), params: { collectionIds: selectedCollections, previewToken: backupPreview.previewToken, trigger: backupPreview.trigger, retainLatest: backupPreview.retainLatest, confirmed: true } });
      else if (current.kind === "restore" && restorePreview) result = await invoke({ method: "backup.restore", requestId: requestId("backup-restore"), params: { backupId: restorePreview.backupId, collectionIds: restorePreview.collections.map((item) => item.id), previewToken: restorePreview.previewToken, confirmed: true } });
      else if (current.kind === "cleanup" && cleanupPreview) result = await invoke({ method: "cleanup.execute", requestId: requestId("cleanup-execute"), params: { candidateIds: selectedCleanup, previewToken: cleanupPreview.previewToken, confirmed: true } });
      if (result) setOperation(result as MaintenanceOperation);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "维护操作失败。"); }
  };

  const cancel = async () => {
    if (!operation || !busy) return;
    try { setOperation(await invoke({ method: "maintenance.operation-cancel", requestId: requestId("cancel"), params: { operationId: operation.id } }) as MaintenanceOperation); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "取消失败。"); }
  };

  const tabs = useMemo(() => [{ id: "backup" as const, label: "备份", icon: DatabaseBackup }, { id: "restore" as const, label: "恢复", icon: RotateCcw }, { id: "storage" as const, label: "空间", icon: HardDrive }], []);
  const openAdvancedConsole = () => {
    const open = window.uclaw?.window?.invoke;
    if (open) void open({ method: "open-advanced-console", requestId: requestId("console"), params: {} });
  };

  return <section className="maintenance-center secondary-view">
    <header><div><h1>系统</h1><h2>数据维护</h2><p>备份、恢复与受控空间清理</p></div><div className="maintenance-head-actions"><button className="secondary-command" type="button" onClick={openAdvancedConsole}><SquareTerminal /><span>打开高级控制台</span></button><div className={`maintenance-availability ${availability}`} role="status"><i className="status-dot" />{statusLabel}</div></div></header>
    <div className="maintenance-tabs" role="tablist" aria-label="数据维护视图">
      {tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}><Icon />{label}</button>)}
      <button className="maintenance-refresh" type="button" aria-label="刷新维护数据" onClick={() => void load()}><RefreshCw className={loading ? "spin" : ""} /></button>
    </div>
    {error ? <div className="data-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>重试</button></div> : null}
    {loading ? <div className="data-state"><LoaderCircle className="spin" /><strong>正在统计受控数据</strong></div> : (
      <div className="maintenance-content">
        {tab === "backup" && backupPreview ? <>
          <section className="maintenance-band"><header><div><h2>备份预览</h2><p>{backupPreview.target} · {backupPreview.totalFileCount} 个文件 · {formatBytes(backupPreview.totalBytes)}</p></div></header>
            <div className="maintenance-list">{backupPreview.collections.map((collection) => <label className="maintenance-row" key={collection.id}><input type="checkbox" checked={selectedCollections.includes(collection.id)} onChange={(event) => {
              const next = event.target.checked ? [...selectedCollections, collection.id] : selectedCollections.filter((id) => id !== collection.id);
              setSelectedCollections(next); void refreshBackupPreview(next);
            }} /><span><strong>{collection.label}</strong><small>{collection.fileCount} 个文件 · {formatBytes(collection.bytes)}</small></span><em>{collection.risk === "sensitive" ? "敏感" : collection.risk === "large" ? "大集合" : "常规"}</em></label>)}</div>
          </section>
          <div className={`maintenance-notice ${coordinated ? "success" : "warning"}`}><AlertTriangle /><span>{backupPreview.warnings[0]}</span></div>
          <footer className="maintenance-actions"><span>{backupPreview.trigger === "manual" ? "手动备份长期保留" : `自动备份保留最近 ${backupPreview.retainLatest} 份`}；自动策略默认保留最近 {backupPreview.retainLatest} 份。</span><button type="button" disabled={!writable || !coordinated || selectedCollections.length === 0 || busy} onClick={() => setConfirmation({ kind: "backup", title: "确认创建备份", body: `将备份 ${backupPreview.totalFileCount} 个文件到当前 U 盘受控备份区。` })}><Archive />创建备份</button></footer>
        </> : null}
        {tab === "restore" ? <div className="maintenance-split"><section><header><h2>可用备份</h2><p>仅显示当前 U 盘受控备份</p></header><div className="maintenance-list">{backups.length ? backups.map((backup) => <button className="maintenance-row" type="button" key={backup.id} disabled={backup.state !== "ready"} onClick={() => void selectBackup(backup)}><Archive /><span><strong>{backup.id}</strong><small>{new Date(backup.createdAt).toLocaleString()} · {backup.fileCount} 个文件 · {formatBytes(backup.bytes)}</small></span><em>{backup.state === "ready" ? "可恢复" : backup.state === "incomplete" ? "需人工恢复" : "损坏"}</em></button>) : <div className="data-state"><Archive /><strong>还没有备份</strong></div>}</div></section>
          <section><header><h2>恢复预览</h2><p>选择备份后校验 manifest 与目标状态</p></header>{restorePreview ? <div className="restore-summary"><strong>将覆盖 {restorePreview.overwriteFileCount} 个文件，新增 {restorePreview.newFileCount} 个文件</strong><p>{restorePreview.totalFileCount} 个文件 · {formatBytes(restorePreview.totalBytes)}</p><ul>{restorePreview.collections.map((item) => <li key={item.id}>{item.label}<span>{item.fileCount} 个文件</span></li>)}</ul><div className="maintenance-notice warning"><AlertTriangle /><span>{restorePreview.warnings[0]}</span></div><button type="button" disabled={!writable || !coordinated || busy} onClick={() => setConfirmation({ kind: "restore", title: "确认恢复", body: "恢复仅覆盖备份内已确认文件；快照外文件保留；失败时自动回滚。" })}><RotateCcw />恢复此备份</button></div> : <div className="data-state"><RotateCcw /><strong>请选择一个备份</strong></div>}</section></div> : null}
        {tab === "storage" && storage && cleanupPreview ? <><section className="maintenance-band"><header><div><h2>空间分类</h2><p>已统计 {formatBytes(storage.totalBytes)}</p></div></header><div className="storage-categories">{storage.categories.map((category) => <div key={category.id}><span>{category.label}{category.protected ? <small>受保护</small> : null}</span><strong>{formatBytes(category.bytes)}</strong></div>)}</div></section>
          <section className="maintenance-band"><header><div><h2>清理预览</h2><p>仅可重建缓存、明确过期诊断和旧备份</p></div></header><div className="maintenance-list">{cleanupPreview.candidates.length ? cleanupPreview.candidates.map((candidate) => <label className="maintenance-row" key={candidate.id}><input type="checkbox" checked={selectedCleanup.includes(candidate.id)} onChange={(event) => setSelectedCleanup(event.target.checked ? [...selectedCleanup, candidate.id] : selectedCleanup.filter((id) => id !== candidate.id))} /><span><strong>{candidate.label}</strong><small>{candidate.reason} · {candidate.fileCount} 个文件</small></span><em>{formatBytes(candidate.bytes)}</em></label>) : <div className="data-state"><CheckCircle2 /><strong>没有可清理数据</strong></div>}</div></section>
          <footer className="maintenance-actions"><span>配置、会话、记忆、能力包、渠道凭据与用户文件永不进入候选。</span><button type="button" disabled={!writable || selectedCleanup.length === 0 || busy} onClick={() => setConfirmation({ kind: "cleanup", title: "确认清理", body: `将清理 ${selectedCleanup.length} 类受控对象。` })}><Trash2 />清理所选</button></footer></> : null}
      </div>
    )}
    {operation ? <aside className={`maintenance-operation ${operation.state}`} aria-live="polite"><div>{busy ? <LoaderCircle className="spin" /> : operation.state === "completed" ? <CheckCircle2 /> : <AlertTriangle />}<span><strong>{operation.message}</strong><small>{operation.processedFiles}/{operation.totalFiles} 个文件 · {formatBytes(operation.processedBytes)}/{formatBytes(operation.totalBytes)}{operation.partialFailures ? ` · ${operation.partialFailures} 项失败` : ""}</small></span></div>{busy ? <button type="button" onClick={() => void cancel()}><X />取消</button> : <button type="button" aria-label="关闭结果" onClick={() => setOperation(undefined)}><X /></button>}</aside> : null}
    {confirmation ? <div className="data-modal-backdrop"><div className="data-modal" role="dialog" aria-modal="true" aria-label={confirmation.title}><h2>{confirmation.title}</h2><p>{confirmation.body}</p><div className="data-confirm-actions"><button type="button" onClick={() => setConfirmation(undefined)}>取消</button><button type="button" onClick={() => void executeConfirmed()}>{confirmation.kind === "backup" ? "确认创建" : confirmation.kind === "restore" ? "确认恢复" : "确认清理"}</button></div></div></div> : null}
  </section>;
}
