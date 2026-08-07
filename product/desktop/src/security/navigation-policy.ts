export interface NavigationEventLike {
  preventDefault(): void;
}

export interface WebContentsLike {
  on(event: "will-navigate", listener: (event: NavigationEventLike, url: string) => void): void;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
}

export interface NavigationPolicyDependencies {
  webContents: WebContentsLike;
  openExternal(url: string): Promise<unknown>;
  allowedProtocols?: readonly string[];
  allowedNavigationOrigins?: readonly string[];
}

export function isAllowedExternalUrl(
  value: string,
  allowedProtocols: readonly string[] = ["https:"],
): boolean {
  try {
    const url = new URL(value);
    return allowedProtocols.includes(url.protocol) && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export function installNavigationPolicy({
  webContents,
  openExternal,
  allowedProtocols = ["https:"],
  allowedNavigationOrigins = [],
}: NavigationPolicyDependencies): void {
  const safelyOpen = (url: string): void => {
    if (!isAllowedExternalUrl(url, allowedProtocols)) return;
    void Promise.resolve(openExternal(url)).catch(() => undefined);
  };

  webContents.on("will-navigate", (event, url) => {
    try {
      if (allowedNavigationOrigins.includes(new URL(url).origin)) return;
    } catch {
      // Invalid URLs remain blocked.
    }
    event.preventDefault();
    safelyOpen(url);
  });
  webContents.setWindowOpenHandler(({ url }) => {
    safelyOpen(url);
    return { action: "deny" };
  });
}
