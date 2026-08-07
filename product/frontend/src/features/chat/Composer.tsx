import { Paperclip, Send, Square } from "lucide-react";

interface ComposerProps {
  value: string;
  disabled: boolean;
  sending: boolean;
  attachmentsSupported: boolean;
  onChange(value: string): void;
  onSend(): void;
  onStop(): void;
}

export function Composer({ value, disabled, sending, attachmentsSupported, onChange, onSend, onStop }: ComposerProps) {
  return <div className="composer">
    <label className="sr-only" htmlFor="chat-composer">给 U-Claw 发送消息</label>
    <textarea id="chat-composer" aria-label="给 U-Claw 发送消息" placeholder="输入消息，或用 @ 引用文件和能力" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSend(); }
    }} />
    <footer><button type="button" disabled={!attachmentsSupported} title={attachmentsSupported ? "添加附件" : "当前连接不支持附件"}><Paperclip />添加附件</button>
      {sending ? <button className="send-button" type="button" aria-label="停止生成" onClick={onStop}><Square />停止</button> : <button className="send-button" type="button" aria-label="发送消息" disabled={disabled || value.trim().length === 0} onClick={onSend}><Send />发送</button>}
    </footer>
  </div>;
}
