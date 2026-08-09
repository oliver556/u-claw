import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigProvider } from "antd";
import type { PropsWithChildren, ReactNode } from "react";
import { createContext, useContext, useState } from "react";
import { createHashRouter, RouterProvider } from "react-router-dom";

import { appTheme, semanticCssVariables } from "../theme/tokens";

const RoutedContent = createContext<ReactNode>(null);

function AppRoute() {
  return useContext(RoutedContent);
}

export function AppProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(() => new QueryClient());
  const [router] = useState(() => createHashRouter([{ path: "*", element: <AppRoute /> }]));

  return (
    <ConfigProvider theme={appTheme}>
      <QueryClientProvider client={queryClient}>
        <RoutedContent.Provider value={<div className="theme-root" style={semanticCssVariables}>{children}</div>}>
          <RouterProvider router={router} />
        </RoutedContent.Provider>
      </QueryClientProvider>
    </ConfigProvider>
  );
}
