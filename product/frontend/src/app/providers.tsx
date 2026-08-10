import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren, ReactNode } from "react";
import { createContext, useContext, useState } from "react";
import { createHashRouter, RouterProvider } from "react-router-dom";

import { AppThemeProvider } from "../theme/ThemeProvider";

const RoutedContent = createContext<ReactNode>(null);

function AppRoute() {
  return useContext(RoutedContent);
}

export function AppProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(() => new QueryClient());
  const [router] = useState(() => createHashRouter([{ path: "*", element: <AppRoute /> }]));

  return (
    <AppThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RoutedContent.Provider value={<div className="theme-root">{children}</div>}>
          <RouterProvider router={router} />
        </RoutedContent.Provider>
      </QueryClientProvider>
    </AppThemeProvider>
  );
}
