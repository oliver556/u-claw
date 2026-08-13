export type SkillInstallIntent = {
  provider: "skillhub";
  identity: `@${string}/${string}`;
  source: "official-prompt";
};

const OFFICIAL_INSTALL_GUIDE = "https://skillhub.cn/install/skillhub.md";
const URL_TOKEN = /https:\/\/[^\s，。；、]+/giu;
const SKILL_IDENTITY = /(?<![A-Za-z0-9_./-])@[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9._-]{0,79}(?![A-Za-z0-9_./-])/giu;
const SHELL_CONTROL = /[;&|`$<>]/u;

export function parseSkillInstallIntent(text: string): SkillInstallIntent | null {
  if (text.length > 8_000 || SHELL_CONTROL.test(text)) return null;

  const urls = [...text.matchAll(URL_TOKEN)].map((match) => match[0]);
  if (urls.length !== 1 || urls[0] !== OFFICIAL_INSTALL_GUIDE) return null;

  const identities = [...text.matchAll(SKILL_IDENTITY)].map((match) => match[0].toLowerCase());
  if (identities.length !== 1) return null;

  return {
    provider: "skillhub",
    identity: identities[0] as `@${string}/${string}`,
    source: "official-prompt",
  };
}
