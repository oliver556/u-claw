import { AppProviders } from "./providers";
import { WorkspaceShell } from "../layout/WorkspaceShell";

export function App() {
  return (
    <AppProviders>
      <WorkspaceShell />
    </AppProviders>
  );
}
