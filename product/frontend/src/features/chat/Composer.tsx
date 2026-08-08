import type { Attachment } from "@uclaw/shared";
import { LoaderCircle, Paperclip, RotateCw, Send, Square, X } from "lucide-react";

interface ComposerProps {
  value: string;
  disabled: boolean;
  sending: boolean;
  attachmentsSupported: boolean;
  attachments: Attachment[];
  onChange(value: string): void;
  onSelectAttachments(): void;
  onDropFiles(files: File[]): void;
  onPrepareAttachment(id: string): void;
  onRemoveAttachment(id: string): void;
  onSend(): void;
  onStop(): void;
}

export function Composer({ value, disabled, sending, attachmentsSupported, attachments, onChange, onSelectAttachments, onDropFiles, onPrepareAttachment, onRemoveAttachment, onSend, onStop }: ComposerProps) {
  const readyAttachments = attachments.filter((attachment) => attachment.state === "ready");
  return <div className="composer" onDragOver={(event) => { if (attachmentsSupported) event.preventDefault(); }} onDrop={(event) => { if (!attachmentsSupported) return; event.preventDefault(); onDropFiles([...event.dataTransfer.files]); }}>
    <label className="sr-only" htmlFor="chat-composer">给 U-Claw 发送消息</label>
    <textarea id="chat-composer" aria-label="给 U-Claw 发送消息" placeholder="输入消息，或用 @ 引用文件和能力" value={value} disabled={disabled || sending} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSend(); }
    }} />
    {attachments.length > 0 ? <ul className="attachment-queue" aria-label="附件队列">{attachments.map((attachment) => <li key={attachment.id}><span><strong>{attachment.file.name}</strong><small>{attachment.state === "failed" ? attachment.error?.message ?? "处理失败" : `${attachment.state}${attachment.progress === undefined ? "" : ` ${Math.round(attachment.progress * 100)}%`}`}</small></span>{attachment.state === "validating" || attachment.state === "uploading" ? <LoaderCircle className="spin" /> : null}{attachment.state === "failed" ? <button type="button" aria-label={`重试 ${attachment.file.name}`} onClick={() => onPrepareAttachment(attachment.id)}><RotateCw /></button> : null}<button type="button" aria-label={`移除 ${attachment.file.name}`} onClick={() => onRemoveAttachment(attachment.id)}><X /></button></li>)}</ul> : null}
    <footer><button type="button" disabled={!attachmentsSupported || disabled} title={attachmentsSupported ? "添加附件" : "当前连接不支持附件"} onClick={onSelectAttachments}><Paperclip />添加附件</button>
      {sending ? <button className="send-button" type="button" aria-label="停止生成" onClick={onStop}><Square />停止</button> : <button className="send-button" type="button" aria-label="发送消息" disabled={disabled || (value.trim().length === 0 && readyAttachments.length === 0) || attachments.some((attachment) => attachment.state !== "ready")} onClick={onSend}><Send />发送</button>}
    </footer>
  </div>;
}
