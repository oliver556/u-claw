import type { Attachment } from "@uclaw/shared";
import { File, LoaderCircle, Play, X } from "lucide-react";
import { useState } from "react";

export type PreviewAttachment = Attachment & { previewUrl?: string; duration?: number; previewFailed?: boolean };

interface AttachmentPreviewProps {
  attachments: PreviewAttachment[];
  onRemove(id: string): void;
}

function formatDuration(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return "--:--";
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  const [failedIds, setFailedIds] = useState(() => new Set<string>());
  const [durations, setDurations] = useState<Record<string, number>>({});
  if (attachments.length === 0) return null;
  return <ul className="attachment-previews" aria-label="附件预览">
    {attachments.map((attachment) => {
      const category = attachment.category ?? (attachment.file.mediaType.startsWith("image/") ? "image" : attachment.file.mediaType.startsWith("video/") ? "video" : "file");
      const previewFailed = attachment.previewFailed || failedIds.has(attachment.id);
      return <li key={attachment.id} aria-label={category === "video" && !previewFailed ? `视频预览 ${attachment.file.name}` : category === "file" || previewFailed ? `附件 ${attachment.file.name}` : undefined}>
        {category === "image" && attachment.previewUrl && !previewFailed ? <img src={attachment.previewUrl} alt={attachment.file.name} onError={() => setFailedIds((current) => new Set(current).add(attachment.id))} /> : null}
        {category === "video" && attachment.previewUrl && !previewFailed ? <div className="video-preview"><video src={attachment.previewUrl} muted preload="metadata" onLoadedMetadata={(event) => setDurations((current) => ({ ...current, [attachment.id]: event.currentTarget.duration }))} onError={() => setFailedIds((current) => new Set(current).add(attachment.id))} /><Play /><time>{formatDuration(attachment.duration ?? durations[attachment.id])}</time></div> : null}
        {(category === "file" || previewFailed || !attachment.previewUrl) ? <div className="file-preview"><File /><span><strong>{attachment.file.name}</strong><small>{attachment.file.mediaType} · {attachment.file.size} B</small></span></div> : null}
        {attachment.state === "uploading" || attachment.state === "validating" ? <div className="attachment-progress"><LoaderCircle className="spin" /><span>{Math.round((attachment.progress ?? 0) * 100)}%</span></div> : null}
        <button type="button" aria-label={`移除 ${attachment.file.name}`} title="移除附件" onClick={() => onRemove(attachment.id)}><X /></button>
      </li>;
    })}
  </ul>;
}
