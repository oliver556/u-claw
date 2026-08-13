import type { UClawClient } from "@uclaw/shared";
import { useEffect, useMemo } from "react";

import { AppProviders } from "./providers";
import { createRendererClient } from "./renderer-client";
import { WorkspaceShell } from "../layout/WorkspaceShell";
import { ActivationFlow } from "../features/activation/ActivationFlow";
import { AppThemeProvider } from "../theme/ThemeProvider";

export function RootApp() {
  if (window.uclawActivation) return <AppThemeProvider><div className="theme-root"><ActivationFlow api={window.uclawActivation} /></div></AppThemeProvider>;
  return <App />;
}

export function App({ client }: { client?: UClawClient }) {
  const preloadBridge = window.uclaw?.client;
  const rendererClient = useMemo(
    () => client === undefined && preloadBridge ? createRendererClient(preloadBridge) : undefined,
    [client, preloadBridge],
  );
  const resolvedClient = client ?? rendererClient;
  useEffect(() => () => rendererClient?.dispose(), [rendererClient]);
  if (!resolvedClient) {
    return (
      <AppProviders>
        <main className="main-canvas" role="status">
          <section className="empty-panel">
            <strong>开发预览</strong>
            <p>当前浏览器未连接 Electron preload。</p>
          </section>
        </main>
      </AppProviders>
    );
  }
  return (
    <AppProviders>
      <WorkspaceShell client={resolvedClient} />
    </AppProviders>
  );
}
