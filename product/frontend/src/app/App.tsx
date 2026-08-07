import { ManualClock, MockUClawClient } from "@uclaw/adapter";
import type { UClawClient } from "@uclaw/shared";
import { useEffect, useMemo } from "react";

import { AppProviders } from "./providers";
import { createRendererClient } from "./renderer-client";
import { WorkspaceShell } from "../layout/WorkspaceShell";

const clock = new ManualClock("2026-08-08T08:00:00.000Z");
const mockClient = new MockUClawClient({ clock, streamDelayMs: 120 });
const defaultClient: UClawClient = {
  gateway: mockClient.gateway,
  sessions: mockClient.sessions,
  chat: {
    ...mockClient.chat,
    send(input, signal) {
      const source = mockClient.chat.send(input, signal);
      return (async function* autoAdvance() {
        const iterator = source[Symbol.asyncIterator]();
        try {
          let first = true;
          while (true) {
            const nextPromise = iterator.next();
            if (!first) await new Promise((resolve) => window.setTimeout(resolve, 180));
            await clock.runAll();
            const next = await nextPromise;
            if (next.done) return;
            first = false;
            yield next.value;
          }
        } finally {
          await iterator.return?.();
        }
      })();
    },
  },
  tools: mockClient.tools,
  approvals: mockClient.approvals,
  models: mockClient.models,
  skills: mockClient.skills,
  channels: mockClient.channels,
  files: mockClient.files,
  diagnostics: mockClient.diagnostics,
};

export function App({ client }: { client?: UClawClient }) {
  const preloadBridge = window.uclaw?.client;
  const resolvedClient = useMemo(
    () => client ?? (preloadBridge ? createRendererClient(preloadBridge) : defaultClient),
    [client, preloadBridge],
  );
  useEffect(() => {
    if (client !== undefined || preloadBridge !== undefined) return;
    const controllableMock = mockClient as MockUClawClient & { setConnectionAvailable(available: boolean): void };
    const setConnection = (event: Event) => controllableMock.setConnectionAvailable((event as CustomEvent<boolean>).detail);
    window.addEventListener("uclaw:mock-connection", setConnection);
    return () => window.removeEventListener("uclaw:mock-connection", setConnection);
  }, [client, preloadBridge]);
  return (
    <AppProviders>
      <WorkspaceShell client={resolvedClient} />
    </AppProviders>
  );
}
