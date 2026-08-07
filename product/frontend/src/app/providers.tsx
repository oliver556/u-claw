import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigProvider } from "antd";
import type { PropsWithChildren } from "react";
import { useState } from "react";
import { HashRouter } from "react-router-dom";

import { appTheme, semanticCssVariables } from "../theme/tokens";

export function AppProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <ConfigProvider theme={appTheme}>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <div className="theme-root" style={semanticCssVariables}>
            {children}
          </div>
        </HashRouter>
      </QueryClientProvider>
    </ConfigProvider>
  );
}
