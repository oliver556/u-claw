import { SkillManager } from "../skills/SkillManager";

export function CapabilitiesView() {
  return <div className="capabilities-view">
    <section className="secondary-view skill-page"><div className="secondary-content skill-content"><SkillManager publicView /></div></section>
  </div>;
}
