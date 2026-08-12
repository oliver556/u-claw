import { SkillManager } from "../skills/SkillManager";

export function CapabilitiesView() {
  return <div className="capabilities-view">
    <section className="secondary-view skill-page"><header><h1>技能</h1><p>管理本地已安装 Skill</p></header><div className="secondary-content skill-content"><SkillManager publicView /></div></section>
  </div>;
}
