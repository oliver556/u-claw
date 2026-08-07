import { contextBridge, ipcRenderer } from "electron";

import { installPreloadBridge } from "./ipc/preload-bridge.js";

installPreloadBridge({
  contextBridge,
  ipcRenderer,
  reportInvalidEvent: (error) => console.warn(error.message),
});
