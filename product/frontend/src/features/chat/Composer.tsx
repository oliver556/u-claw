import { ArrowUp, Paperclip, RotateCw, Square } from "lucide-react";
import { Select } from "antd";
import { AttachmentPreview, type PreviewAttachment } from "./AttachmentPreview";

interface ComposerProps {
  value: string;
  disabled: boolean;
  sending: boolean;
  attachmentsSupported: boolean;
  attachments: PreviewAttachment[];
  models: Array<{ value: string; label: string; disabled?: boolean }>;
  modelValue?: string;
  modelLoading: boolean;
  modelError: boolean;
  skills: Array<{ value: string; label: string }>;
  skillValue?: string;
  skillLoading: boolean;
  onChange(value: string): void;
  onSelectAttachments(): void;
  onDropFiles(files: File[]): void;
  onPasteFiles?(files: File[]): void;
  onPrepareAttachment(id: string): void;
  onRemoveAttachment(id: string): void;
  onSend(): void;
  onQueue?(): void;
  onStop(): void;
  onModelChange(value: string): void;
  onSkillChange(value?: string): void;
}

export function Composer({ value, disabled, sending, attachmentsSupported, attachments, models, modelValue, modelLoading, modelError, skills, skillValue, skillLoading, onChange, onSelectAttachments, onDropFiles, onPasteFiles, onPrepareAttachment, onRemoveAttachment, onSend, onQueue, onStop, onModelChange, onSkillChange }: ComposerProps) {
  const readyAttachments = attachments.filter((attachment) => attachment.state === "ready");
  return <div className="composer borderless-composer" onDragOver={(event) => { if (attachmentsSupported) event.preventDefault(); }} onDrop={(event) => { if (!attachmentsSupported) return; event.preventDefault(); onDropFiles([...event.dataTransfer.files]); }}>
    <AttachmentPreview attachments={attachments} onRemove={onRemoveAttachment} />
    <label className="sr-only" htmlFor="chat-composer">给 U-Claw 发送消息</label>
    <textarea id="chat-composer" aria-label="给 U-Claw 发送消息" placeholder="输入消息，或用 @ 引用文件和能力" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} onPaste={(event) => {
      const files = [...event.clipboardData.files];
      if (files.length === 0) return;
      event.preventDefault();
      onPasteFiles?.(files);
    }} onKeyDown={(event) => {
      if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) onQueue?.();
      else onSend();
    }} />
    {attachments.some((attachment) => attachment.state === "failed") ? <ul className="attachment-queue" aria-label="附件队列">{attachments.filter((attachment) => attachment.state === "failed").map((attachment) => <li key={attachment.id}><span><strong>{attachment.file.name}</strong><small>{attachment.error?.message ?? "处理失败"}</small></span><button type="button" aria-label={`重试 ${attachment.file.name}`} onClick={() => onPrepareAttachment(attachment.id)}><RotateCw /></button></li>)}</ul> : null}
    <footer><div className="composer-tools"><button type="button" disabled={!attachmentsSupported || disabled} title={attachmentsSupported ? "添加附件" : "当前连接不支持附件"} onClick={onSelectAttachments}><Paperclip />添加附件</button>
      <Select aria-label="会话模型" size="small" loading={modelLoading} status={modelError ? "error" : undefined} value={modelValue} placeholder={modelError ? "模型不可用" : "选择模型"} options={models} onChange={onModelChange} />
      <Select aria-label="下一条消息 Skill" size="small" allowClear loading={skillLoading} value={skillValue} placeholder="选择 Skill" options={skills} onChange={onSkillChange} onClear={() => onSkillChange(undefined)} />
      </div>
      {sending ? <button className="send-button composer-action" type="button" aria-label="停止生成" title="停止" onClick={onStop}><Square /></button> : <button className="send-button composer-action" type="button" aria-label="发送消息" title="发送" disabled={disabled || (value.trim().length === 0 && readyAttachments.length === 0) || attachments.some((attachment) => attachment.state !== "ready")} onClick={onSend}><ArrowUp /></button>}
    </footer>
  </div>;
}
