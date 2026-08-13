import { ArrowDownLeft, ArrowUpRight, CalendarDays, Coins, CreditCard, Plus } from "lucide-react";
import { useState } from "react";

type TransactionType = "recharge" | "usage";
type TransactionFilter = "all" | TransactionType;

interface PreviewTransaction {
  id: string;
  time: string;
  type: TransactionType;
  description: string;
  change: number;
  balance: number;
}

const BALANCE_PREVIEW = {
  current: 128,
  recharged: 560,
  consumed: 432,
};

const TRANSACTION_PREVIEW: PreviewTransaction[] = [
  { id: "tx-5", time: "2026-08-14 09:42", type: "usage", description: "GPT-5.6 Sol 对话", change: -6, balance: 128 },
  { id: "tx-4", time: "2026-08-13 21:18", type: "usage", description: "GPT Image 2 图片生成", change: -12, balance: 134 },
  { id: "tx-3", time: "2026-08-12 14:06", type: "recharge", description: "微信支付充值", change: 100, balance: 146 },
  { id: "tx-2", time: "2026-08-11 16:30", type: "usage", description: "Claude Opus 4.1 任务执行", change: -18, balance: 46 },
  { id: "tx-1", time: "2026-08-10 10:12", type: "recharge", description: "支付宝充值", change: 50, balance: 64 },
];

const FILTERS: Array<{ value: TransactionFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "recharge", label: "充值" },
  { value: "usage", label: "消耗" },
];

function formatPoints(value: number): string {
  return value.toLocaleString("zh-CN");
}

export interface BalanceViewProps {
  onRecharge?: () => void;
}

export function BalanceView({ onRecharge }: BalanceViewProps) {
  const [filter, setFilter] = useState<TransactionFilter>("all");
  const transactions = filter === "all"
    ? TRANSACTION_PREVIEW
    : TRANSACTION_PREVIEW.filter((transaction) => transaction.type === filter);

  return <section className="billing-view" role="region" aria-label="余额与积分">
    <header className="billing-page-header">
      <div>
        <h1>余额</h1>
        <p>查看积分余额与收支明细</p>
      </div>
      <button type="button" className="primary-action" onClick={onRecharge}>
        <Plus aria-hidden="true" />
        充值积分
      </button>
    </header>

    <div className="billing-summary-grid" aria-label="积分概览">
      <article className="billing-summary-card billing-summary-card-primary" aria-label="当前积分">
        <span className="billing-summary-icon"><Coins aria-hidden="true" /></span>
        <div><small>当前积分</small><strong>{formatPoints(BALANCE_PREVIEW.current)}</strong></div>
      </article>
      <article className="billing-summary-card" aria-label="累计充值">
        <span className="billing-summary-icon"><ArrowDownLeft aria-hidden="true" /></span>
        <div><small>累计充值</small><strong>{formatPoints(BALANCE_PREVIEW.recharged)}</strong><span>积分</span></div>
      </article>
      <article className="billing-summary-card" aria-label="累计消耗">
        <span className="billing-summary-icon"><ArrowUpRight aria-hidden="true" /></span>
        <div><small>累计消耗</small><strong>{formatPoints(BALANCE_PREVIEW.consumed)}</strong><span>积分</span></div>
      </article>
    </div>

    <section className="billing-ledger" aria-labelledby="balance-ledger-title">
      <header className="billing-ledger-header">
        <div>
          <h2 id="balance-ledger-title">收支明细</h2>
          <p>记录近30天的积分变动</p>
        </div>
        <button type="button" className="secondary-action" aria-label="时间范围：近30天">
          <CalendarDays aria-hidden="true" />
          近30天
        </button>
      </header>

      <div className="billing-filter-bar" role="group" aria-label="流水类型">
        {FILTERS.map((item) => <button
          key={item.value}
          type="button"
          className={filter === item.value ? "is-active" : undefined}
          aria-pressed={filter === item.value}
          onClick={() => setFilter(item.value)}
        >{item.label}</button>)}
      </div>

      <div className="billing-table-scroll">
        <table className="billing-table">
          <thead><tr><th scope="col">时间</th><th scope="col">类型</th><th scope="col">说明</th><th scope="col">积分变动</th><th scope="col">余额</th></tr></thead>
          <tbody>{transactions.map((transaction) => <tr key={transaction.id}>
            <td>{transaction.time}</td>
            <td><span className={`billing-type billing-type-${transaction.type}`}>
              {transaction.type === "recharge" ? <CreditCard aria-hidden="true" /> : <Coins aria-hidden="true" />}
              {transaction.type === "recharge" ? "充值" : "消耗"}
            </span></td>
            <td>{transaction.description}</td>
            <td className={transaction.change > 0 ? "billing-positive" : "billing-negative"}>
              {transaction.change > 0 ? "+" : ""}{formatPoints(transaction.change)}
            </td>
            <td>{formatPoints(transaction.balance)}</td>
          </tr>)}</tbody>
        </table>
      </div>

      <footer className="billing-pagination" aria-label="流水分页">
        <span>共 {transactions.length} 条</span>
        <div><button type="button" disabled aria-label="上一页">‹</button><button type="button" className="is-active" aria-current="page">1</button><button type="button" disabled aria-label="下一页">›</button></div>
      </footer>
    </section>
  </section>;
}
