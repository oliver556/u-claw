import { describe, expect, it } from "vitest";

import { parseSkillInstallIntent } from "../src/skill-install-intent.js";

describe("parseSkillInstallIntent", () => {
  it("parses the official SkillHub installation prompt", () => {
    expect(parseSkillInstallIntent([
      "请根据 https://skillhub.cn/install/skillhub.md，",
      "安装 @user_164f4c1f/global-biblio-base。",
    ].join("\n"))).toEqual({
      provider: "skillhub",
      identity: "@user_164f4c1f/global-biblio-base",
      source: "official-prompt",
    });
  });

  it.each([
    ["普通聊天", "帮我找一个适合写作的 Skill"],
    ["缺少身份", "请根据 https://skillhub.cn/install/skillhub.md 安装这个 Skill"],
    ["多个身份", "请根据 https://skillhub.cn/install/skillhub.md 安装 @alice/one 和 @bob/two"],
    ["伪造 host", "请根据 https://skillhub.cn.evil.example/install/skillhub.md 安装 @alice/one"],
    ["伪造 path 后缀", "请根据 https://skillhub.cn/install/skillhub.md.evil 安装 @alice/one"],
    ["身份尾随路径", "请根据 https://skillhub.cn/install/skillhub.md 安装 @alice/one/extra"],
    ["shell 拼接", "请根据 https://skillhub.cn/install/skillhub.md 安装 @alice/one; rm -rf /tmp/x"],
    ["命令替换", "请根据 https://skillhub.cn/install/skillhub.md 安装 @alice/one $(whoami)"],
  ])("rejects %s", (_label, text) => {
    expect(parseSkillInstallIntent(text)).toBeNull();
  });
});
