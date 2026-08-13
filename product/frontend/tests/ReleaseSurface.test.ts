import { describe, expect, it } from "vitest";

import { firstReleaseSurface } from "../src/app/release-surface";

describe("first release surface", () => {
  it("defines the first release visibility whitelist", () => {
    expect(firstReleaseSurface.hiddenPrimaryPaths).toEqual([
      "/files",
      "/memory",
      "/automation",
    ]);
    expect(firstReleaseSurface.systemViews).toEqual(["release", "appearance"]);
    expect(firstReleaseSurface.channelKinds).toEqual(["wechat-personal"]);
    expect(firstReleaseSurface.titlebar).toEqual({
      globalSearch: false,
      modelStatus: false,
    });
  });
});
