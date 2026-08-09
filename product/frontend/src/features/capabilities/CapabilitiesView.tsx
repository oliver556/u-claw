import { useState } from "react";

import { ProviderSettings } from "../providers/ProviderSettings";
import { SkillManager } from "../skills/SkillManager";

export function CapabilitiesView() {
  const [tab, setTab] = useState<"models" | "skills">("models");
  return <div className="capabilities-view">
    <div className="capability-tabs" role="tablist" aria-label="能力类型">
      <button role="tab" aria-selected={tab === "models"} onClick={() => setTab("models")}>模型</button>
      <button role="tab" aria-selected={tab === "skills"} onClick={() => setTab("skills")}>技能</button>
    </div>
    {tab === "models" ? <ProviderSettings /> : <section className="secondary-view skill-page"><header><h1>技能</h1><p>免费 Skill 目录与 U 盘生命周期</p></header><div className="secondary-content skill-content"><SkillManager /></div></section>}
  </div>;
}
