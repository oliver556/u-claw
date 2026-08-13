import { Package } from "lucide-react";
import { useEffect, useState } from "react";

import "./SkillLogo.css";

const TRUSTED_LOGO_HOSTS = new Set([
  "api.skillhub.cn",
  "skillhub-1388575217.cos.accelerate.myqcloud.com",
]);

function trustedLogoUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && TRUSTED_LOGO_HOSTS.has(url.hostname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export type SkillLogoProps = {
  name: string;
  logoUrl?: string | null;
  className?: string;
};

export function SkillLogo({ name, logoUrl, className }: SkillLogoProps) {
  const source = trustedLogoUrl(logoUrl);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  const classes = ["skill-logo", className].filter(Boolean).join(" ");

  if (source && !failed) {
    return <span className={classes}><img src={source} alt={`${name} Logo`} onError={() => setFailed(true)} /></span>;
  }
  return <span className={`${classes} skill-logo-fallback`} role="img" aria-label={`${name} Skill 图标`}><Package aria-hidden="true" /></span>;
}
