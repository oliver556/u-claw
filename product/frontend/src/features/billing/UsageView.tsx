import { useState } from "react";
import {
  CalendarDays,
  Coins,
  Download,
  Image,
  MessageSquareText,
  Sparkles,
  Wrench,
} from "lucide-react";

type Range = 7 | 14 | 30;
type UsageType = "全部" | "文字" | "图片" | "工具";

const dailyPreview = [
  8, 13, 6, 19, 11, 25, 14, 7, 12, 9,
  18, 15, 20, 10, 23, 16, 8, 17, 13, 22,
  11, 19, 26, 14, 21, 12, 18, 15, 24, 14,
];

const modelPreview = [
  { name: "GPT-5.6 Sol", percent: 57, points: 246 },
  { name: "GPT Image 2", percent: 28, points: 121 },
  { name: "GPT-5.5", percent: 15, points: 65 },
];

const recordsPreview = [
  { id: 1, title: "整理会议纪要", type: "文字" as const, model: "GPT-5.6 Sol", time: "今天 10:42", points: 8 },
  { id: 2, title: "生成商品主图", type: "图片" as const, model: "GPT Image 2", time: "今天 09:18", points: 4 },
  { id: 3, title: "搜索工作区文件", type: "工具" as const, model: "GPT-5.5", time: "今天 08:36", points: 2 },
  { id: 4, title: "生成项目周报", type: "文字" as const, model: "GPT-5.6 Sol", time: "昨天 18:20", points: 11 },
];

const typeIcons = {
  "文字": MessageSquareText,
  "图片": Image,
  "工具": Wrench,
};

export function UsageView() {
  const [range, setRange] = useState<Range>(7);
  const [type, setType] = useState<UsageType>("全部");
  const chartData = dailyPreview.slice(-range);
  const visibleRecords = type === "全部" ? recordsPreview : recordsPreview.filter((record) => record.type === type);
  const maxValue = Math.max(...chartData);

  return (
    <section className="usage-view" aria-label="积分使用量">
      <header className="usage-header">
        <div>
          <h1>使用量</h1>
          <p>查看积分消耗、使用趋势与模型分布</p>
        </div>
        <div className="usage-header-actions">
          <button type="button"><CalendarDays aria-hidden="true" />近 30 天</button>
          <button type="button"><Download aria-hidden="true" />导出</button>
        </div>
      </header>

      <div className="usage-content">
        <section className="usage-metrics" aria-label="使用概览">
          <Metric icon={<Coins />} label="当前积分" value="128" />
          <Metric icon={<Sparkles />} label="今日消耗" value="14" unit="积分" />
          <Metric icon={<Sparkles />} label="近 7 天" value="96" unit="积分" />
          <Metric icon={<CalendarDays />} label="预计可用" value="9" unit="天" />
        </section>

        <div className="usage-analysis-grid">
          <section className="usage-panel usage-trend" aria-labelledby="usage-trend-title">
            <header>
              <div><h2 id="usage-trend-title">消耗趋势</h2><p>每日积分消耗</p></div>
              <div className="usage-range-switch" aria-label="趋势时间范围">
                {([7, 14, 30] as const).map((days) => <button type="button" className={range === days ? "active" : ""} aria-pressed={range === days} key={days} onClick={() => setRange(days)}>{days} 天</button>)}
              </div>
            </header>
            <svg className="usage-chart" viewBox={`0 0 ${chartData.length * 30} 156`} role="group" aria-label={`近 ${range} 天积分消耗柱状图`}>
              {chartData.map((value, index) => {
                const height = Math.round((value / maxValue) * 104);
                const day = 15 - range + index;
                return <g key={`${range}-${index}`}>
                  <rect role="img" aria-label={`8月${day}日消耗${value}积分`} x={index * 30 + 5} y={116 - height} width="18" height={height} rx="4" />
                  <text x={index * 30 + 14} y={132} textAnchor="middle">{day}</text>
                  <text x={index * 30 + 14} y={150} textAnchor="middle">{value}</text>
                </g>;
              })}
            </svg>
          </section>

          <section className="usage-panel usage-models" aria-labelledby="usage-models-title">
            <header><div><h2 id="usage-models-title">模型分布</h2><p>近 30 天</p></div></header>
            <div className="usage-model-list">
              {modelPreview.map((model) => <div className="usage-model" key={model.name}>
                <div><strong>{model.name}</strong><span>{model.percent}%</span></div>
                <progress aria-label={`${model.name} ${model.percent}%`} value={model.percent} max="100" />
                <small>{model.points} 积分</small>
              </div>)}
            </div>
          </section>
        </div>

        <section className="usage-panel usage-records" aria-labelledby="usage-records-title">
          <header>
            <div><h2 id="usage-records-title">使用明细</h2><p>记录近 30 天的积分消耗</p></div>
            <div className="usage-type-filter" aria-label="使用类型">
              {(["全部", "文字", "图片", "工具"] as const).map((item) => <button type="button" className={type === item ? "active" : ""} aria-pressed={type === item} key={item} onClick={() => setType(item)}>{item}</button>)}
            </div>
          </header>
          <div className="usage-record-list">
            {visibleRecords.map((record) => {
              const Icon = typeIcons[record.type];
              return <article className="usage-record" key={record.id}>
                <i><Icon aria-hidden="true" /></i>
                <div><strong>{record.title}</strong><span>{record.model} · {record.time}</span></div>
                <em>{record.type}</em>
                <b>-{record.points} 积分</b>
              </article>;
            })}
          </div>
        </section>
      </div>
    </section>
  );
}

function Metric({ icon, label, value, unit }: { icon: React.ReactNode; label: string; value: string; unit?: string }) {
  return <article className="usage-metric"><i aria-hidden="true">{icon}</i><div><span>{label}</span><strong>{value}{unit ? <small>{unit}</small> : null}</strong></div></article>;
}
