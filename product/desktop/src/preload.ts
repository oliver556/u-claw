import { contextBridge, ipcRenderer } from "electron";

import { installActivationPreloadBridge, installPreloadBridge } from "./ipc/preload-bridge.js";
import { parseStartupMode } from "./startup/mode.js";

const dependencies = {
  contextBridge,
  ipcRenderer,
  reportInvalidEvent: (error: Error) => console.warn(error.message),
};
if (parseStartupMode(process.argv) === "activation-only") installActivationPreloadBridge(dependencies);
else installPreloadBridge(dependencies);
