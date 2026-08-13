// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SkillLogo } from "../src/features/skills/SkillLogo";

describe("SkillLogo", () => {
  afterEach(cleanup);

  it("renders a trusted SkillHub logo", () => {
    render(<SkillLogo name="Workspace Reader" logoUrl="https://api.skillhub.cn/assets/workspace-reader.png" />);
    expect(screen.getByRole("img", { name: "Workspace Reader Logo" })).toHaveAttribute("src", "https://api.skillhub.cn/assets/workspace-reader.png");
  });

  it.each([
    ["missing", undefined],
    ["untrusted", "file:///tmp/workspace-reader.png"],
  ])("uses the unified Skill icon for %s logos", (_case, logoUrl) => {
    const { container } = render(<SkillLogo name="Workspace Reader" logoUrl={logoUrl} />);
    expect(screen.queryByText("W")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Workspace Reader Skill 图标" })).toBeVisible();
    expect(container.querySelector(".lucide-package")).toBeInTheDocument();
  });

  it("falls back when a trusted logo fails to load", () => {
    const { container } = render(<SkillLogo name="Workspace Reader" logoUrl="https://api.skillhub.cn/assets/missing.png" />);
    fireEvent.error(screen.getByRole("img", { name: "Workspace Reader Logo" }));
    expect(container.querySelector(".lucide-package")).toBeInTheDocument();
  });
});
