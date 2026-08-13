export const firstReleaseSurface = {
  hiddenPrimaryPaths: ["/files", "/memory", "/automation"],
  systemViews: ["release", "appearance"],
  channelKinds: ["wechat-personal"],
  titlebar: { globalSearch: false, modelStatus: false },
} as const;

export const firstReleaseHiddenPrimaryPathSet = new Set<string>(
  firstReleaseSurface.hiddenPrimaryPaths,
);
