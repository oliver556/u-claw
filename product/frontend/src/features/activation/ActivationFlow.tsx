import { Check, Eye, EyeOff, KeyRound, LockKeyhole, ShieldCheck, Usb, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { formatActivationCode, normalizeActivationCode, type ActivationApi, type ActivationStatus, useActivation } from "./useActivation";
import "./activation.css";

declare global {
  interface Window { uclawActivation?: ActivationApi }
}

const progressCopy: Partial<Record<ActivationStatus["state"], [string, string]>> = {
  submitting: ["正在验证激活信息", "正在安全校验激活码与库存状态"],
  "server-bound": ["已绑定当前 U 盘", "正在获取设备专属启动授权"],
  writing: ["正在安全写入产品盘", "请勿拔出 U 盘或关闭窗口"],
  verifying: ["正在完成本地验签", "正在确认许可证与当前产品盘一致"],
  committing: ["正在确认激活结果", "授权材料已写入，即将重新启动"],
};

const errorCopy: Record<string, { title: string; detail: string; retry: boolean }> = {
  ACTIVATION_INVALID: { title: "激活码不正确", detail: "请对照产品随附的激活卡重新输入。", retry: true },
  INVALID_INPUT: { title: "激活信息格式不正确", detail: "激活码应为 26 位。", retry: true },
  ACTIVATION_SERVICE_UNAVAILABLE: { title: "激活服务暂时不可用", detail: "请检查网络连接，稍后重试。", retry: true },
  ACTIVATION_CODE_ALREADY_BOUND: { title: "此激活码已绑定其他 U 盘", detail: "当前产品盘无法使用此激活码，请联系售后处理。", retry: false },
  USB_MISSING: { title: "未检测到产品盘", detail: "请重新插入 U-Claw 产品盘后重试。", retry: true },
  PREFLIGHT_FAILED: { title: "启动检查未通过", detail: "无法安全读取当前产品盘，请重新插入后重试。", retry: true },
};

function BrandMark({ large = false }: { large?: boolean }) {
  return <span className={`activation-brand-mark${large ? " large" : ""}`} aria-hidden="true"><i /><i /><i /></span>;
}

function Rail({ state }: { state: ActivationStatus["state"] }) {
  const active = state === "checking" ? 1 : state === "input" || state === "error" ? 2 : state === "complete" ? 3 : 2;
  return <aside className="activation-rail" aria-label="激活进度">
    <div className="activation-rail-brand"><BrandMark /><div><strong>U-Claw</strong><small>随身 AI 工作空间</small></div></div>
    <ol>{[["启动", "识别产品盘"], ["检查", "确认运行条件"], ["激活", "绑定当前 U 盘"], ["完成", "写入启动授权"]].map(([title, detail], index) =>
      <li className={index < active ? "done" : index === active ? "active" : ""} key={title}><span>{index < active ? <Check /> : index + 1}</span><div><strong>{title}</strong><small>{detail}</small></div></li>)}</ol>
    <div className="activation-device"><Usb /><div><small>当前产品盘</small><strong>U-Claw</strong><span>{state === "checking" ? "正在识别" : "安全连接"}</span></div></div>
  </aside>;
}

function Processing({ status }: { status: ActivationStatus }) {
  const [title, detail] = status.state === "checking"
    ? ["正在确认产品盘", "正在检查设备身份与安全写入条件"]
    : progressCopy[status.state] ?? ["正在恢复本次激活", "正在核对同一产品盘上的未完成记录"];
  return <section className="activation-center" role="status">
    <div className="activation-emblem"><BrandMark large /><span /></div>
    <p className="activation-kicker">安全激活</p><h1>{title}</h1><p>{detail}</p>
    {status.state === "checking" ? <ol className="activation-check-list" aria-label="启动检查项">
      {["Windows 与处理器", "内存与可用空间", "U 盘设备身份", "激活服务连接"].map((label) => <li key={label}><span className="activation-task-dot" /><strong>{label}</strong><em>检查中</em></li>)}
    </ol> : <ActivationTasks state={status.state} />}
    <div className="activation-progress"><span /></div>
    <small>激活过程中请勿拔出 U 盘</small>
  </section>;
}

const activationTasks = [
  ["验证激活凭据", "确认激活码与库存状态"],
  ["绑定 U 盘身份", "绑定当前产品盘的稳定设备标识"],
  ["签发启动许可证", "获取设备专属签名授权"],
  ["安全写入产品盘", "原子写入并读回启动凭据"],
  ["完成本地验签", "确认许可证与当前 U 盘一致"],
] as const;

function ActivationTasks({ state }: { state: ActivationStatus["state"] }) {
  const progress: Partial<Record<ActivationStatus["state"], { done: number; active: number | null }>> = {
    submitting: { done: 0, active: 0 },
    "server-bound": { done: 3, active: null },
    writing: { done: 3, active: 3 },
    verifying: { done: 4, active: 4 },
    committing: { done: 5, active: null },
  };
  const current = progress[state] ?? progress.submitting!;
  return <ol className="activation-task-list" aria-label="激活任务">{activationTasks.map(([title, detail], index) => {
    const className = index < current.done ? "done" : index === current.active ? "active" : "waiting";
    return <li className={className} key={title}><span className="activation-task-dot">{className === "done" ? <Check /> : null}</span><div><strong>{title}</strong><small>{detail}</small></div><em>{className === "done" ? "完成" : className === "active" ? "处理中" : "等待"}</em></li>;
  })}</ol>;
}

function Success() {
  return <section className="activation-center activation-success" role="status">
    <div className="activation-success-seal"><Check /></div><p className="activation-kicker">激活完成</p>
    <h1>这套 U-Claw 已可使用</h1><p>启动授权已安全写入当前 U 盘，正在重新执行完整启动检查。</p>
    <div className="activation-receipt"><ShieldCheck /><div><strong>本地验签通过</strong><small>启动凭据、数字签名与 U 盘身份一致</small></div><span>有效</span></div>
  </section>;
}

function ActivationForm({ recovery, onSubmit }: { recovery: boolean; onSubmit(code: string): void }) {
  const [code, setCode] = useState("");
  const [visible, setVisible] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => codeRef.current?.focus(), []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const valid = /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(normalizeActivationCode(code));
    setInvalid(!valid);
    if (valid) onSubmit(code);
  };
  return <section className="activation-form-area">
    <header><p className="activation-kicker">{recovery ? "同盘恢复" : "首次激活"}</p><h1>{recovery ? "继续完成本次激活" : "激活这套 U-Claw"}</h1><p>{recovery ? "检测到当前 U 盘有未完成的激活记录。请重新输入同一激活码继续。" : "激活码首次使用后将绑定当前 U 盘。换电脑、换接口或换盘符不受影响。"}</p></header>
    <form onSubmit={submit} noValidate>
      <div className="activation-field"><label htmlFor="activation-code">激活码</label><div className="activation-input"><KeyRound /><input id="activation-code" ref={codeRef} type={visible ? "text" : "password"} value={formatActivationCode(code)} onChange={(event) => setCode(event.target.value)} autoComplete="off" spellCheck={false} maxLength={30} aria-invalid={invalid} aria-describedby="activation-code-help" aria-errormessage={invalid ? "activation-code-error" : undefined} /><button type="button" aria-label={visible ? "隐藏激活码" : "显示激活码"} title={visible ? "隐藏激活码" : "显示激活码"} onClick={() => setVisible((value) => !value)}>{visible ? <EyeOff /> : <Eye />}</button></div><small id="activation-code-help">激活码不区分大小写</small>{invalid && <small id="activation-code-error" role="alert">请输入 26 位有效激活码</small>}</div>
      <div className="activation-binding"><Usb /><div><small>即将绑定</small><strong>当前 U-Claw 产品盘</strong></div><span><LockKeyhole /> 安全读取</span></div>
      <button className="activation-primary" type="submit"><ShieldCheck />{recovery ? "继续恢复" : "激活当前 U 盘"}</button>
    </form>
    <aside className="activation-summary"><h2>本次激活</h2><dl><div><dt>授权方式</dt><dd>单 U 盘永久绑定</dd></div><div><dt>允许换机</dt><dd>是</dd></div><div><dt>首次激活</dt><dd>需要联网</dd></div></dl><p><LockKeyhole /><span><strong>激活码与模型密钥相互独立</strong><small>授权服务只保存设备指纹摘要。</small></span></p></aside>
  </section>;
}

function ErrorView({ status, retry, close }: { status: ActivationStatus; retry(): void; close(): Promise<ActivationStatus> }) {
  const copy = errorCopy[status.code ?? ""] ?? { title: "激活未完成", detail: "请重试；问题持续时请联系售后。", retry: true };
  return <section className="activation-center activation-error" role="alert"><div className="activation-error-mark">!</div><p className="activation-kicker">需要处理</p><h1>{copy.title}</h1><p>{copy.detail}</p><div className="activation-actions">{copy.retry && <button className="activation-primary" onClick={retry}>重试</button>}<button className="activation-secondary" onClick={() => void close()}>关闭</button></div></section>;
}

export function ActivationFlow({ api }: { api: ActivationApi }) {
  const { status, preflight, submit, close } = useActivation(api);
  const processing = ["submitting", "server-bound", "writing", "verifying", "committing"].includes(status.state);
  return <div className="activation-shell" data-testid="activation-shell" style={{ maxWidth: "100%" }}>
    <a className="skip-link" href="#activation-main">跳到主要内容</a>
    <header className="activation-titlebar"><div><BrandMark /><strong>U-Claw</strong><span>启动与激活</span></div><button onClick={() => void close()} aria-label="关闭" title="关闭"><X /></button></header>
    <div className="activation-body"><Rail state={status.state} /><main id="activation-main" className="activation-stage" aria-live="polite">
      {status.state === "checking" && <Processing status={status} />}
      {status.state === "input" && <ActivationForm recovery={false} onSubmit={(code) => void submit(code)} />}
      {status.state === "recovery-required" && <ActivationForm recovery onSubmit={(code) => void submit(code)} />}
      {processing && <Processing status={status} />}
      {status.state === "complete" && <Success />}
      {status.state === "error" && <ErrorView status={status} retry={() => void preflight()} close={close} />}
    </main></div>
  </div>;
}
