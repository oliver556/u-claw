// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SkillLogo } from "../src/features/skills/SkillLogo";

describe("SkillLogo", () => {
  afterEach(cleanup);

  it("renders a trusted SkillHub logo", () => {
    const logoUrl = "https://cloudcache.tencent-cloud.com/qcloud/ui/static/workspace-reader.png";
    render(<SkillLogo name="Workspace Reader" logoUrl={logoUrl} />);
    expect(screen.getByRole("img", { name: "Workspace Reader Logo" })).toHaveAttribute("src", logoUrl);
  });

  it.each([
    ["missing", undefined],
    ["untrusted", "file:///tmp/workspace-reader.png"],
    ["host suffix attack", "https://cloudcache.tencent-cloud.com.evil.example/workspace-reader.png"],
    ["insecure transport", "http://cloudcache.tencent-cloud.com/workspace-reader.png"],
    ["embedded credentials", "https://user:pass@cloudcache.tencent-cloud.com/workspace-reader.png"],
  ])("uses the Skill initial for %s logos", (_case, logoUrl) => {
    const { container } = render(<SkillLogo name="Workspace Reader" logoUrl={logoUrl} />);
    expect(screen.getByText("W")).toBeVisible();
    expect(screen.getByRole("img", { name: "Workspace Reader Skill 图标" })).toBeVisible();
    expect(container.querySelector(".lucide-package")).not.toBeInTheDocument();
  });

  it("falls back when a trusted logo fails to load", () => {
    const { container } = render(<SkillLogo name="Workspace Reader" logoUrl="https://api.skillhub.cn/assets/missing.png" />);
    fireEvent.error(screen.getByRole("img", { name: "Workspace Reader Logo" }));
    expect(screen.getByText("W")).toBeVisible();
    expect(container.querySelector(".lucide-package")).not.toBeInTheDocument();
  });
});
