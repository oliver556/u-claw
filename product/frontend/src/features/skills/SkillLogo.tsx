import { SKILLHUB_TRUSTED_LOGO_HOSTS } from "@uclaw/shared";
import { useEffect, useState } from "react";

import "./SkillLogo.css";

/** Returns only exact trusted SkillHub HTTPS image URLs for renderer use. */
function trustedLogoUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      SKILLHUB_TRUSTED_LOGO_HOSTS.some((host) => host === url.hostname)
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

/** Renders a trusted remote logo or a stable initial when no usable image exists. */
export function SkillLogo({ name, logoUrl, className }: SkillLogoProps) {
  const source = trustedLogoUrl(logoUrl);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  const classes = ["skill-logo", className].filter(Boolean).join(" ");
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?";

  if (source && !failed) {
    return <span className={classes}><img src={source} alt={`${name} Logo`} onError={() => setFailed(true)} /></span>;
  }
  return <span className={`${classes} skill-logo-fallback`} role="img" aria-label={`${name} Skill 图标`}>{initial}</span>;
}
