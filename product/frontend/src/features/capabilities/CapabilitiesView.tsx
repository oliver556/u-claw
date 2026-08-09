import { useState } from "react";

import { ProviderSettings } from "../providers/ProviderSettings";
import { SkillManager } from "../skills/SkillManager";
import { PluginManager } from "../plugins/PluginManager";

export function CapabilitiesView() {
  const [tab, setTab] = useState<"models" | "skills" | "plugins">("models");
  return <div className="capabilities-view">
    <div className="capability-tabs" role="tablist" aria-label="能力类型">
      <button role="tab" aria-selected={tab === "models"} onClick={() => setTab("models")}>模型</button>
      <button role="tab" aria-selected={tab === "skills"} onClick={() => setTab("skills")}>技能</button>
      <button role="tab" aria-selected={tab === "plugins"} onClick={() => setTab("plugins")}>插件</button>
    </div>
    {tab === "models" ? <ProviderSettings /> : tab === "skills" ? <section className="secondary-view skill-page"><header><h1>技能</h1><p>免费 Skill 目录与 U 盘生命周期</p></header><div className="secondary-content skill-content"><SkillManager /></div></section> : <section className="secondary-view plugin-page"><header><h1>插件</h1><p>OpenClaw Plugin 独立目录与 U 盘生命周期</p></header><div className="secondary-content plugin-content"><PluginManager /></div></section>}
  </div>;
}
