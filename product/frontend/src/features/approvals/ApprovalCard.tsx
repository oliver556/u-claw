import type { ApprovalDecision, ApprovalRequest } from "@uclaw/shared";
import { LoaderCircle, PlugZap, ShieldAlert, TerminalSquare } from "lucide-react";
import { useState } from "react";

const decisionLabels: Record<ApprovalDecision, string> = { "allow-once": "允许一次", "allow-session": "本会话允许", deny: "拒绝" };

interface ApprovalCardProps {
  approval: ApprovalRequest;
  canResolve: boolean;
  onResolve?(approval: ApprovalRequest, decision: ApprovalDecision): void | Promise<void>;
}

export function ApprovalCard({ approval, canResolve, onResolve }: ApprovalCardProps) {
  const [submitting, setSubmitting] = useState(false);
  const [resolveError, setResolveError] = useState<string>();
  const Icon = approval.family === "exec" ? TerminalSquare : PlugZap;
  const familyLabel = approval.family === "exec" ? "命令执行授权" : "插件授权";
  return <section className="approval-card" aria-label={`${familyLabel}：${approval.title}`}>
    <header><Icon /><strong>{familyLabel}</strong><span className={`risk risk-${approval.risk}`}><ShieldAlert />{approval.risk}</span></header>
    <h3>{approval.title}</h3><p>{approval.description}</p>
    <ul>{approval.permissions.map((permission) => <li key={`${permission.kind}-${permission.scope}`}><strong>{permission.scope}</strong><span>{permission.description}</span></li>)}</ul>
    <footer>{approval.choices.map((decision) => <button key={decision} type="button" disabled={!canResolve || submitting} onClick={() => { if (submitting) return; setResolveError(undefined); setSubmitting(true); void Promise.resolve(onResolve?.(approval, decision)).catch((error) => setResolveError(error instanceof Error ? error.message : "授权处理失败")).finally(() => setSubmitting(false)); }}>{submitting ? <LoaderCircle className="spin" /> : decisionLabels[decision]}</button>)}</footer>
    {resolveError ? <small className="approval-error" role="alert">授权失败：{resolveError}</small> : null}
    {!canResolve ? <small>当前连接不支持在此处理授权，请在 OpenClaw 中确认。</small> : null}
  </section>;
}
